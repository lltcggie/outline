import { createAppAuth, type InstallationAuthOptions } from "@octokit/auth-app";
import type { Endpoints, OctokitResponse } from "@octokit/types";
import { addSeconds } from "date-fns";
import { Octokit, RequestError } from "octokit";
import pluralize from "pluralize";
import type { Transaction } from "sequelize";
import { z } from "zod";
import { toError, errToString } from "@shared/utils/error";
import {
  IntegrationService,
  IntegrationType,
  UnfurlResourceType,
} from "@shared/types";
import { createContext } from "@server/context";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import { Integration, IntegrationAuthentication } from "@server/models";
import { sequelize } from "@server/storage/database";
import type {
  UnfurlIssueOrPR,
  UnfurlProject,
  UnfurlSignature,
} from "@server/types";
import fetch from "@server/utils/fetch";
import { GitHubUtils } from "../shared/GitHubUtils";
import env from "./env";

/** An installation of the app as listed for the user that can access it. */
export type UserInstallation =
  Endpoints["GET /user/installations"]["response"]["data"]["installations"][number];

type PR =
  Endpoints["GET /repos/{owner}/{repo}/pulls/{pull_number}"]["response"]["data"];
type Issue =
  Endpoints["GET /repos/{owner}/{repo}/issues/{issue_number}"]["response"]["data"];
type Installation =
  Endpoints["GET /app/installations/{installation_id}"]["response"]["data"];

type ParsedIssueOrPR = {
  owner: string;
  repo: string;
  type: UnfurlResourceType.Issue | UnfurlResourceType.PR;
  id: number;
  url: string;
};

type ParsedProject = {
  owner: string;
  ownerType: "orgs" | "users";
  type: UnfurlResourceType.Project;
  projectNumber: number;
  url: string;
};

type GitHubResource = ParsedIssueOrPR | ParsedProject;

type GitHubProject = {
  number: number;
  title: string;
  description: string | null;
  url: string;
  createdAt: string;
  closed: boolean;
};

type LinkedAccount = Integration<IntegrationType.LinkedAccount>;

const requestTimeout = 10_000;

// The body of a successful response from the OAuth token endpoint. The
// expiration and refresh token are only issued when the app is configured to
// expire user tokens.
const AccessTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

// The body of an error from the OAuth token endpoint, which GitHub sends with
// status 200, see RFC 6749 §5.2.
const TokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

// The errors of a GraphQL response in which every error says that the
// resource does not exist or is not visible to the user.
const GraphqlNotFoundErrorsSchema = z
  .array(z.object({ type: z.enum(["NOT_FOUND", "FORBIDDEN"]) }))
  .nonempty();

/** A refusal of the OAuth token endpoint, with the OAuth error code. */
export class GitHubTokenError extends Error {
  constructor(
    /**
     * The OAuth error code, such as "bad_refresh_token" when the refresh
     * token was revoked or has expired.
     */
    public code: string,
    description?: string
  ) {
    super(
      `GitHub refused the token request: ${code}${description ? ` (${description})` : ""}`
    );
  }
}

const requestPlugin = (octokit: Octokit) => ({
  requestRepos: () =>
    octokit.paginate.iterator(
      octokit.rest.apps.listReposAccessibleToInstallation,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    ),

  requestPR: async (params: ParsedIssueOrPR) =>
    octokit.request(`GET /repos/{owner}/{repo}/pulls/{pull_number}`, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.id,
      headers: {
        Accept: "application/vnd.github.text+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),

  requestIssue: async (params: ParsedIssueOrPR) =>
    octokit.request(`GET /repos/{owner}/{repo}/issues/{issue_number}`, {
      owner: params.owner,
      repo: params.repo,
      issue_number: params.id,
      headers: {
        Accept: "application/vnd.github.text+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),

  /**
   * Fetches details of a GitHub ProjectV2 using the GraphQL API.
   *
   * @param params Parsed project URL identifiers.
   * @returns Project data or undefined if not found.
   */
  requestProject: async (
    params: ParsedProject
  ): Promise<GitHubProject | undefined> => {
    const ownerField = params.ownerType === "orgs" ? "organization" : "user";

    const query = `query($login: String!, $number: Int!) {
      ${ownerField}(login: $login) {
        projectV2(number: $number) {
          number
          title
          shortDescription
          url
          createdAt
          closed
        }
      }
    }`;

    const result = await octokit.graphql<
      Record<
        string,
        {
          projectV2: {
            number: number;
            title: string;
            shortDescription: string | null;
            url: string;
            createdAt: string;
            closed: boolean;
          } | null;
        }
      >
    >(query, { login: params.owner, number: params.projectNumber });

    const project = result[ownerField]?.projectV2;
    if (!project) {
      return undefined;
    }

    return {
      number: project.number,
      title: project.title,
      description: project.shortDescription,
      url: project.url,
      createdAt: project.createdAt,
      closed: project.closed,
    };
  },

  /**
   * Fetches app installations accessible to the user
   *
   * @returns {Array} Containing details of all app installations done by user
   */
  requestAppInstallations: async () =>
    octokit.paginate("GET /user/installations"),

  /**
   * Fetches the GitHub account the client is authenticated as.
   *
   * @returns Response containing the account details.
   */
  requestCurrentUser: async () =>
    octokit.request("GET /user", {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),

  /**
   * Fetches details of a specific GitHub app installation
   *
   * @param installationId Id of the installation to fetch
   * @returns Response containing installation details
   */
  requestAppInstallation: async (
    installationId: number
  ): Promise<OctokitResponse<Installation>> =>
    octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }),

  /**
   * Uninstalls the GitHub app from a given target
   *
   * @param installationId Id of the target from where to uninstall
   */
  requestAppUninstall: async (installationId: number) =>
    octokit.request("DELETE /app/installations/{id}", {
      id: installationId,
    }),
});

const CustomOctokit = Octokit.plugin(requestPlugin);

/**
 * The GitHub API on behalf of the users that linked their accounts: the OAuth
 * token exchange, the requests for issues, pull requests and projects, and the
 * unfurling of github.com links with the access of the requesting user. The
 * app's installations, which an admin adds for the workspace, only decide
 * which repositories the app can reach at all, every request is made with a
 * user's own token and so sees no more than that user can see in GitHub.
 */
export class GitHub {
  private static appId = env.GITHUB_APP_ID;
  private static appKey = env.GITHUB_APP_PRIVATE_KEY
    ? Buffer.from(env.GITHUB_APP_PRIVATE_KEY, "base64").toString("ascii")
    : undefined;

  private static clientId = env.GITHUB_CLIENT_ID;
  private static clientSecret = env.GITHUB_CLIENT_SECRET;

  private static tokenUrl = "https://github.com/login/oauth/access_token";

  private static appOctokit: Octokit;

  private static supportedResources = [
    UnfurlResourceType.Issue,
    UnfurlResourceType.PR,
  ];

  /**
   * Parses a given URL and returns resource identifiers for GitHub specific URLs
   *
   * @param url URL to parse
   * @returns {object} Containing resource identifiers - `owner`, `repo`, `type` and `id`.
   */
  public static parseUrl(url: string): GitHubResource | undefined {
    try {
      const { hostname, pathname } = new URL(url);
      if (hostname !== GitHubUtils.hostname) {
        return;
      }

      const parts = pathname.split("/");

      // Handle project URLs: /orgs/{org}/projects/{number} or /users/{user}/projects/{number}
      if (
        (parts[1] === "orgs" || parts[1] === "users") &&
        parts[3] === "projects"
      ) {
        const ownerType = parts[1] as "orgs" | "users";
        const owner = parts[2];
        const projectNumber = Number(parts[4]);

        if (!owner || isNaN(projectNumber)) {
          return;
        }

        return {
          owner,
          ownerType,
          type: UnfurlResourceType.Project,
          projectNumber,
          url,
        };
      }

      const owner = parts[1];
      const repo = parts[2];
      const type = parts[3]
        ? (pluralize.singular(parts[3]) as UnfurlResourceType)
        : undefined;
      const id = Number(parts[4]);

      if (!type || !GitHub.supportedResources.includes(type) || isNaN(id)) {
        return;
      }

      return {
        owner,
        repo,
        type: type as UnfurlResourceType.Issue | UnfurlResourceType.PR,
        id,
        url,
      };
    } catch (_err) {
      // Invalid URL format
      return;
    }
  }

  /**
   * Exchanges the code of the OAuth web flow for a user access token.
   *
   * @param code the authorization code from the OAuth callback.
   * @returns the access token, with its lifetime and a refresh token when the
   * app is configured to expire user tokens.
   * @throws {GitHubTokenError} when GitHub refuses the code.
   */
  public static oauthAccess(code: string) {
    return this.tokenRequest({ code, redirect_uri: GitHubUtils.callbackUrl() });
  }

  /**
   * Obtains a new user access token with a refresh token.
   *
   * @param refreshToken the refresh token issued with the previous token.
   * @returns the new access token, its lifetime and the next refresh token.
   * @throws {GitHubTokenError} when GitHub refuses the refresh token, with the
   * code "bad_refresh_token" when it was revoked or has expired.
   */
  public static async refreshToken(refreshToken: string) {
    const response = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      // A refreshed token always expires, the app issued a refresh token.
      expires_in: response.expires_in ?? 8 * 60 * 60,
    };
  }

  /**
   * Revokes a user access token, so that one stored for a removed account
   * cannot be used any more. A token GitHub no longer knows is ignored.
   *
   * @param token the access token to revoke.
   */
  public static async revokeToken(token: string) {
    const credentials = Buffer.from(
      `${this.clientId}:${this.clientSecret}`
    ).toString("base64");
    const res = await fetch(
      `https://api.github.com/applications/${this.clientId}/token`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ access_token: token }),
        timeout: requestTimeout,
      }
    );
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(
        `Error while revoking GitHub access token; status: ${res.status}`
      );
    }
  }

  /**
   * Revokes a user access token that is not kept, such as one replaced by
   * linking again, one issued for a link that was not completed, or one of a
   * removed account. A failure is only logged: the token expires on its own,
   * and the caller has nothing left to fail over.
   *
   * @param token the access token to revoke.
   */
  public static async discardToken(token: string) {
    try {
      await this.revokeToken(token);
    } catch (err) {
      Logger.warn(
        "Failed to revoke the GitHub access token that is not kept",
        toError(err)
      );
    }
  }

  /**
   * Fetches the GitHub account a user access token belongs to.
   *
   * @param token the user access token.
   * @returns the account details.
   */
  public static async getCurrentUser(token: string) {
    const res = await this.createUserClient(token).requestCurrentUser();
    return {
      id: res.data.id,
      login: res.data.login,
      avatarUrl: res.data.avatar_url,
    };
  }

  /**
   * Fetches the installations of the app that a user has access to.
   *
   * @param token the user access token.
   * @returns the installations.
   */
  public static getUserInstallations(
    token: string
  ): Promise<UserInstallation[]> {
    return this.createUserClient(token).requestAppInstallations();
  }

  /**
   * Fetches an issue with a user's access.
   *
   * @param token the user access token.
   * @param params the parsed issue URL.
   * @returns the issue.
   * @throws {RequestError} when GitHub refuses the request, with status 404
   * when the user cannot see the issue.
   */
  public static async getIssue(
    token: string,
    params: ParsedIssueOrPR
  ): Promise<Issue> {
    const res = await this.createUserClient(token).requestIssue(params);
    return res.data;
  }

  /**
   * Fetches a pull request with a user's access.
   *
   * @param token the user access token.
   * @param params the parsed pull request URL.
   * @returns the pull request.
   * @throws {RequestError} when GitHub refuses the request, with status 404
   * when the user cannot see the pull request.
   */
  public static async getPullRequest(
    token: string,
    params: ParsedIssueOrPR
  ): Promise<PR> {
    const res = await this.createUserClient(token).requestPR(params);
    return res.data;
  }

  /**
   * Fetches a project with a user's access.
   *
   * @param token the user access token.
   * @param params the parsed project URL.
   * @returns the project, or undefined when the user cannot see it.
   * @throws {RequestError} when GitHub refuses the request, with status 401
   * when the token was rejected.
   */
  public static async getProject(
    token: string,
    params: ParsedProject
  ): Promise<GitHubProject | undefined> {
    try {
      return await this.createUserClient(token).requestProject(params);
    } catch (err) {
      // GitHub answers for a project that does not exist or that the user
      // cannot see with a null project and an error, which the client turns
      // into an exception.
      if (this.isGraphqlNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * [Authenticates as a GitHub app installation](https://github.com/octokit/auth-app.js/?tab=readme-ov-file#authenticate-as-installation).
   * Only used to manage the installation itself, never to fetch resources on
   * behalf of users.
   *
   * @param installationId Id of an installation
   * @returns {Octokit} Installation-authenticated octokit instance
   */
  public static authenticateAsInstallation = async (installationId: number) =>
    GitHub.authenticateAsApp().auth({
      type: "installation",
      installationId,
      factory: (options: InstallationAuthOptions) =>
        new CustomOctokit({
          authStrategy: createAppAuth,
          auth: options,
        }),
    }) as Promise<InstanceType<typeof CustomOctokit>>;

  /**
   * Whether an admin added any installation of the app to a team.
   *
   * @param teamId the team to check.
   * @returns true if the team has a workspace integration.
   */
  public static async hasWorkspaceIntegrations(teamId: string) {
    const count = await Integration.count({
      where: {
        service: IntegrationService.GitHub,
        type: IntegrationType.Embed,
        teamId,
      },
    });
    return count > 0;
  }

  /**
   * Finds the workspace integration of a team for an installation of the app.
   *
   * @param teamId the team the integration must belong to.
   * @param installationId the id of the installation.
   * @param options the query options.
   * @returns the workspace integration, if any.
   */
  public static async findWorkspaceIntegrationByInstallation(
    teamId: string,
    installationId: number,
    options: { transaction?: Transaction } = {}
  ) {
    return Integration.findOne<Integration<IntegrationType.Embed>>({
      where: {
        service: IntegrationService.GitHub,
        type: IntegrationType.Embed,
        teamId,
        "settings.github.installation.id": installationId,
      },
      transaction: options.transaction,
    });
  }

  /**
   * Finds the GitHub accounts linked in a team.
   *
   * @param params.teamId the team to search.
   * @param params.userId the user to limit the search to, all users when unset.
   * @param options the query options.
   * @returns the linked account integrations, with their authentication if any.
   */
  public static async findLinkedAccounts(
    { teamId, userId }: { teamId: string; userId?: string },
    options: { transaction?: Transaction } = {}
  ) {
    return Integration.findAll<LinkedAccount>({
      where: {
        service: IntegrationService.GitHub,
        type: IntegrationType.LinkedAccount,
        teamId,
        ...(userId ? { userId } : {}),
      },
      include: [
        {
          model: IntegrationAuthentication,
          as: "authentication",
          required: false,
        },
      ],
      transaction: options.transaction,
    });
  }

  /**
   * Finds the GitHub account a user linked, with the token to unfurl with.
   * Each user only ever gets their own.
   *
   * @param user the user that linked the account.
   * @returns the linked account integration with its authentication, or
   * undefined when the user has not linked an account.
   */
  public static async findLinkedAccount(user: User) {
    const integrations = await this.findLinkedAccounts({
      teamId: user.teamId,
      userId: user.id,
    });
    return integrations.find((integration) => integration.authentication);
  }

  /**
   * Removes linked accounts together with their stored tokens.
   *
   * @param linkedAccounts the linked account integrations to remove.
   * @param options the query options.
   */
  public static async destroyLinkedAccounts(
    linkedAccounts: LinkedAccount[],
    options: { transaction?: Transaction } = {}
  ) {
    for (const linkedAccount of linkedAccounts) {
      // Destroying with force also removes the stored token.
      await linkedAccount.destroy({
        transaction: options.transaction,
        force: true,
      });
    }
  }

  /**
   * Unfurls a GitHub resource with the access of the given user. Only the
   * user's own linked account is used, so the result never reveals more than
   * the user can see in GitHub themselves.
   *
   * @param url GitHub resource url
   * @param actor User attempting to unfurl resource url
   * @returns An object containing resource details e.g, a GitHub Pull Request
   * details, an error when the URL belongs to GitHub but cannot be unfurled
   * for the user, or undefined when the URL does not belong to GitHub.
   */
  public static unfurl: UnfurlSignature = async (url: string, actor?: User) => {
    if (!actor || !GitHubUtils.isGitHubUrl(url)) {
      return;
    }

    const linkedAccount = await this.findLinkedAccount(actor);

    // GitHub is not in use, so its links are left to later unfurl providers.
    // Only checked when the user has no account, which is the rare path.
    if (
      !linkedAccount &&
      !(await this.hasWorkspaceIntegrations(actor.teamId))
    ) {
      return;
    }

    // Other URLs on GitHub, such as commits or files, are not passed on to
    // later unfurl providers, which may be external services.
    const resource = this.parseUrl(url);
    if (!resource) {
      return { error: "Unsupported GitHub URL" };
    }

    if (!linkedAccount) {
      Logger.debug(
        "plugins",
        `No linked GitHub account found for user ${actor.id}`
      );
      return { error: "GitHub account not linked" };
    }

    try {
      const token = await linkedAccount.authentication.refreshTokenIfNeeded(
        (refreshToken) => this.refreshToken(refreshToken)
      );

      try {
        return await this.unfurlResource(token, resource);
      } catch (err) {
        if (!(err instanceof RequestError) || err.status !== 401) {
          throw err;
        }

        // The token was rejected although it should still be valid, which
        // happens when the user revokes the app in GitHub, or when a refresh
        // above failed and the expired token was kept.
        const recovered = await this.recoverAccess(linkedAccount, actor, token);
        if (!recovered) {
          return { error: "GitHub account not linked" };
        }
        return await this.unfurlResource(recovered, resource);
      }
    } catch (err) {
      if (err instanceof RequestError && this.isRateLimited(err)) {
        // The user's token reached a rate limit, which says nothing about
        // the resource, so this is not treated as the resource being
        // invisible to the user.
        Logger.warn(
          `GitHub rate limit reached for user ${actor.id} (${err.status})`,
          err
        );
        return { error: "GitHub rate limit reached" };
      }

      if (
        err instanceof RequestError &&
        (err.status === 403 || err.status === 404)
      ) {
        // Not visible to the user, or not in a repository the app is
        // installed on.
        Logger.debug(
          "plugins",
          `GitHub ${resource.type} ${url} is not visible to user ${actor.id} (${err.status})`
        );
        return { error: "Resource not found" };
      }

      if (err instanceof GitHubTokenError) {
        // A refresh that GitHub refused for a reason other than a revoked
        // token is a problem of the installation rather than of the resource.
        Logger.error(
          "GitHub refused to refresh an access token, check GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET",
          err
        );
        return { error: errToString(err) };
      }

      Logger.warn("Failed to fetch resource from GitHub", toError(err));
      return {
        error: errToString(err) || "Unknown error",
      };
    }
  };

  private static authenticateAsApp = () => {
    if (!GitHub.appOctokit) {
      GitHub.appOctokit = new CustomOctokit({
        authStrategy: createAppAuth,
        auth: {
          appId: GitHub.appId,
          privateKey: GitHub.appKey,
          clientId: GitHub.clientId,
          clientSecret: GitHub.clientSecret,
        },
      });
    }

    return GitHub.appOctokit;
  };

  /**
   * Creates a client that makes requests with a user's access token.
   *
   * @param token the user access token.
   * @returns the client.
   */
  private static createUserClient(token: string) {
    return new CustomOctokit({ auth: token });
  }

  /**
   * Whether an error is a GraphQL response whose errors all say that the
   * resource does not exist or cannot be seen. The client's error class is
   * not exported by the octokit package, so the error is recognized by its
   * name and the errors it carries.
   *
   * @param err the error the GraphQL request threw.
   * @returns true if the resource is not visible to the user.
   */
  private static isGraphqlNotFound(err: unknown): boolean {
    if (
      !(err instanceof Error) ||
      err.name !== "GraphqlResponseError" ||
      !("errors" in err)
    ) {
      return false;
    }
    return GraphqlNotFoundErrorsSchema.safeParse(err.errors).success;
  }

  /**
   * Whether GitHub refused a request because the user's token reached a rate
   * limit. A primary limit is reported with status 403 and no remaining
   * requests, a secondary limit with status 429 or with status 403 and a
   * retry-after header.
   *
   * @param err the error the request threw.
   * @returns true if the request was rate limited.
   */
  private static isRateLimited(err: RequestError): boolean {
    if (err.status === 429) {
      return true;
    }
    const headers = err.response?.headers;
    return (
      err.status === 403 &&
      (headers?.["x-ratelimit-remaining"] === "0" ||
        headers?.["retry-after"] !== undefined)
    );
  }

  /**
   * Requests a token from GitHub's OAuth token endpoint on behalf of the app.
   *
   * @param params the grant parameters, such as the code or refresh token.
   * @returns the parsed response.
   * @throws {GitHubTokenError} when GitHub does not issue a token.
   */
  private static async tokenRequest(params: Record<string, string>) {
    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: this.clientId ?? "",
        client_secret: this.clientSecret ?? "",
        ...params,
      }),
      timeout: requestTimeout,
    });

    const body: unknown = await res.json();
    const error = TokenErrorSchema.safeParse(body);
    if (error.success) {
      throw new GitHubTokenError(
        error.data.error,
        error.data.error_description
      );
    }
    if (res.status !== 200) {
      throw new Error(
        `Error while requesting access token from GitHub; status: ${res.status}`
      );
    }

    return AccessTokenResponseSchema.parse(body);
  }

  /**
   * Refreshes the access token of a linked account after GitHub rejected it.
   * When GitHub also rejects the refresh token itself the user has revoked the
   * app, so the linked account is removed and the user is asked to connect
   * again in their settings. A refresh that GitHub refuses for any other
   * reason, such as wrong app credentials, is a problem of the installation
   * and leaves the account in place.
   *
   * @param linkedAccount the linked account whose token was rejected.
   * @param actor the user the account belongs to.
   * @param rejectedToken the access token GitHub rejected.
   * @returns the new access token, or undefined when the account was removed.
   * @throws {Error} when the refresh fails for another reason, such as a
   * network error or a misconfigured app.
   */
  private static async recoverAccess(
    linkedAccount: LinkedAccount,
    actor: User,
    rejectedToken: string
  ): Promise<string | undefined> {
    const { authentication } = linkedAccount;

    // Without a refresh token, which an app that does not expire user tokens
    // never issues, the access cannot be restored.
    if (!authentication.refreshToken) {
      await this.removeRevokedAccount(linkedAccount, actor);
      return;
    }

    try {
      // GitHub invalidates a refresh token once it is used, so recoveries are
      // serialized on the authentication row as in refreshTokenIfNeeded. One
      // that finds the rejected token already replaced uses the replacement
      // rather than spending the new refresh token.
      return await sequelize.transaction(async (transaction) => {
        const locked = await IntegrationAuthentication.findByPk(
          authentication.id,
          { transaction, lock: transaction.LOCK.UPDATE }
        );
        if (!locked || !locked.refreshToken) {
          return undefined;
        }
        if (locked.token !== rejectedToken) {
          return locked.token;
        }

        const refreshed = await this.refreshToken(locked.refreshToken);
        await locked.update(
          {
            token: refreshed.access_token,
            refreshToken: refreshed.refresh_token || locked.refreshToken,
            expiresAt: addSeconds(Date.now(), refreshed.expires_in),
          },
          { transaction }
        );
        return refreshed.access_token;
      });
    } catch (err) {
      if (err instanceof GitHubTokenError && err.code === "bad_refresh_token") {
        await this.removeRevokedAccount(linkedAccount, actor);
        return;
      }
      throw err;
    }
  }

  /**
   * Removes a linked account whose access was revoked in GitHub, the same way
   * as when the user disconnects it in their settings: the integration is
   * deleted with an event, and the processor of that event clears the
   * previews fetched with the account and removes its stored tokens.
   *
   * @param linkedAccount the linked account to remove.
   * @param actor the user the account belongs to.
   */
  private static async removeRevokedAccount(
    linkedAccount: LinkedAccount,
    actor: User
  ): Promise<void> {
    Logger.info(
      "plugins",
      `GitHub access of user ${actor.id} was revoked, removing the linked account`
    );
    await linkedAccount.destroyWithCtx(createContext({ user: actor }));
  }

  private static async unfurlResource(token: string, resource: GitHubResource) {
    if (resource.type === UnfurlResourceType.Project) {
      const project = await this.getProject(token, resource);
      if (!project) {
        return { error: "Resource not found" };
      }
      return this.transformProject(project);
    }

    if (resource.type === UnfurlResourceType.Issue) {
      return this.transformIssue(await this.getIssue(token, resource));
    }

    return this.transformPR(await this.getPullRequest(token, resource));
  }

  private static transformProject(project: GitHubProject) {
    const state = project.closed ? "completed" : "open";

    return {
      type: UnfurlResourceType.Project,
      url: project.url,
      id: `#${project.number}`,
      name: project.title,
      color: GitHubUtils.getColorForStatus(state),
      description: project.description,
      lead: null,
      state: {
        type: state,
        name: state,
        color: GitHubUtils.getColorForStatus(state),
      },
      labels: [],
      createdAt: project.createdAt,
      targetDate: null,
    } satisfies UnfurlProject;
  }

  private static transformIssue(issue: Issue) {
    const issueState =
      issue.state === "closed"
        ? issue.state_reason === "completed"
          ? "completed"
          : "canceled"
        : issue.state;
    return {
      type: UnfurlResourceType.Issue,
      url: issue.html_url,
      id: `#${issue.number}`,
      title: issue.title,
      description: issue.body_text ?? null,
      author: {
        name: issue.user?.login ?? "",
        avatarUrl: issue.user?.avatar_url ?? "",
      },
      labels: issue.labels.map((label: { name: string; color: string }) => ({
        name: label.name,
        color: `#${label.color}`,
      })),
      state: {
        name: issueState,
        color: GitHubUtils.getColorForStatus(issueState),
      },
      createdAt: issue.created_at,
    } satisfies UnfurlIssueOrPR;
  }

  private static transformPR(pr: PR) {
    const prState = pr.merged ? "merged" : pr.state;
    return {
      type: UnfurlResourceType.PR,
      url: pr.html_url,
      id: `#${pr.number}`,
      title: pr.title,
      description: pr.body,
      author: {
        name: pr.user.login,
        avatarUrl: pr.user.avatar_url,
      },
      state: {
        name: prState,
        color: GitHubUtils.getColorForStatus(prState, !!pr.draft),
        draft: pr.draft,
      },
      createdAt: pr.created_at,
    } satisfies UnfurlIssueOrPR;
  }
}
