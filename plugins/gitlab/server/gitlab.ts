import { Gitlab } from "@gitbeaker/rest";
import type {
  EpicSchema,
  IssueSchemaWithExpandedLabels,
  MergeRequestSchema,
  ProjectSchema,
  SimpleLabelSchema,
  StatisticsSchema,
} from "@gitbeaker/rest";
import { sortBy } from "es-toolkit";
import type { Transaction } from "sequelize";
import z from "zod";
import {
  IntegrationService,
  IntegrationType,
  UnfurlResourceType,
} from "@shared/types";
import { toError, errToString } from "@shared/utils/error";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import { Integration, IntegrationAuthentication } from "@server/models";
import type {
  UnfurlIssueOrPR,
  UnfurlProject,
  UnfurlSignature,
} from "@server/types";
import fetch from "@server/utils/fetch";
import { validateUrlNotPrivate } from "@server/utils/url";
import { GitLabUtils } from "../shared/GitLabUtils";
import env from "./env";

const AccessTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
  created_at: z.number(),
});

export class GitLab {
  private static clientSecret = env.GITLAB_CLIENT_SECRET;
  private static clientId = env.GITLAB_CLIENT_ID;

  /** Includes the authentication of an integration, if any, in a query. */
  private static get authenticationInclude() {
    return [
      {
        model: IntegrationAuthentication,
        as: "authentication",
        required: false,
      },
    ];
  }

  /**
   * Creates a Gitbeaker client instance.
   *
   * @param accessToken - The access token for authentication.
   * @param customUrl - Optional custom GitLab URL from integration settings.
   * @returns A configured Gitbeaker client.
   */
  public static async createClient(accessToken: string, customUrl?: string) {
    const host = customUrl || GitLabUtils.defaultGitlabUrl;

    // Validate the URL to prevent SSRF as GitLab instance does not use our
    // fetch wrapper which has built-in SSRF protection.
    await validateUrlNotPrivate(host);

    return new Gitlab({
      host,
      oauthToken: accessToken,
    });
  }

  /**
   * Fetches an issue from a GitLab project.
   *
   * @param accessToken - The access token for authentication.
   * @param projectPath - The project path (owner/repo).
   * @param issueIid - The issue IID (internal ID within the project).
   * @param customUrl - Optional custom GitLab URL from integration settings.
   * @returns The issue data.
   */
  public static async getIssue(
    accessToken: string,
    projectPath: string,
    issueIid: number,
    customUrl?: string
  ) {
    const client = await this.createClient(accessToken, customUrl);

    const issues = await client.Issues.all({
      projectId: projectPath,
      iids: [issueIid],
      withLabelsDetails: true,
    });

    if (!issues || issues.length === 0) {
      throw new Error(`Issue ${issueIid} not found in project ${projectPath}`);
    }

    return issues[0];
  }

  /**
   * Fetches an epic from a GitLab group.
   *
   * @param accessToken - The access token for authentication.
   * @param groupPath - The full path of the group.
   * @param epicIid - The epic IID (internal ID within the group).
   * @param customUrl - Optional custom GitLab URL from integration settings.
   * @returns The epic data.
   */
  public static async getEpic(
    accessToken: string,
    groupPath: string,
    epicIid: number,
    customUrl?: string
  ) {
    const client = await this.createClient(accessToken, customUrl);
    return client.Epics.show(groupPath, epicIid);
  }

  /**
   * Fetches a merge request from a GitLab project.
   *
   * @param accessToken - The access token for authentication.
   * @param projectPath - The project path (owner/repo).
   * @param mrIid - The merge request IID (internal ID within the project).
   * @param customUrl - Optional custom GitLab URL from integration settings.
   * @returns The merge request data.
   */
  public static async getMergeRequest(
    accessToken: string,
    projectPath: string,
    mrIid: number,
    customUrl?: string
  ) {
    const client = await this.createClient(accessToken, customUrl);
    const mr = await client.MergeRequests.show(projectPath, mrIid);
    return mr;
  }

  /**
   * Fetches current user information.
   *
   * @param params.accessToken - Access token received from OAuth flow.
   * @param params.customUrl - Optional custom GitLab URL. Falls back to default.
   * @returns User information including the resolved URL.
   */
  public static async getCurrentUser({
    accessToken,
    customUrl,
  }: {
    accessToken: string;
    customUrl?: string;
  }) {
    const url = customUrl || GitLabUtils.defaultGitlabUrl;
    const client = await this.createClient(accessToken, url);

    const userData = await client.Users.showCurrentUser({
      showExpanded: false,
    });
    return { ...userData, url };
  }

  /**
   * Finds the workspace integrations that configure a GitLab instance for a
   * team, including those that are still being connected, see `isConnected`.
   * These hold the OAuth application, never a token used for unfurling.
   *
   * @param teamId the team to find integrations for.
   * @param options the query options.
   * @returns the workspace integrations, with their authentication if any.
   */
  public static async findWorkspaceIntegrations(
    teamId: string,
    options: { transaction?: Transaction } = {}
  ) {
    return (await Integration.findAll({
      where: {
        service: IntegrationService.GitLab,
        type: IntegrationType.Embed,
        teamId,
      },
      include: this.authenticationInclude,
      // A previous version could configure the same instance several times,
      // the oldest is used as in the cleanup script.
      order: [
        ["createdAt", "ASC"],
        ["id", "ASC"],
      ],
      transaction: options.transaction,
    })) as Integration<IntegrationType.Embed>[];
  }

  /**
   * Whether a workspace integration has completed connecting its instance.
   * Until then its OAuth application may not work, so it is not used.
   *
   * @param integration the workspace integration.
   * @returns true if the integration is connected.
   */
  public static isConnected(integration: Integration<IntegrationType.Embed>) {
    return !integration.settings?.gitlab?.pending;
  }

  /**
   * Finds a workspace integration of a team by id, including one that is still
   * being connected.
   *
   * @param teamId the team the integration must belong to.
   * @param id the id of the integration.
   * @param options the query options.
   * @returns the workspace integration with its authentication, if any.
   */
  public static async findWorkspaceIntegrationById(
    teamId: string,
    id: string,
    options: { transaction?: Transaction } = {}
  ) {
    return (await Integration.findOne({
      where: {
        id,
        service: IntegrationService.GitLab,
        type: IntegrationType.Embed,
        teamId,
      },
      include: this.authenticationInclude,
      transaction: options.transaction,
    })) as Integration<IntegrationType.Embed> | null;
  }

  /**
   * Finds the GitLab accounts linked for a GitLab instance in a team.
   *
   * @param params.teamId the team to search.
   * @param params.userId the user to limit the search to, all users when unset.
   * @param params.customUrl the instance URL, gitlab.com when unset.
   * @param options the query options.
   * @returns the linked account integrations, with their authentication if any.
   */
  public static async findLinkedAccounts(
    {
      teamId,
      userId,
      customUrl,
    }: { teamId: string; userId?: string; customUrl?: string },
    options: { transaction?: Transaction } = {}
  ) {
    const integrations = (await Integration.findAll({
      where: {
        service: IntegrationService.GitLab,
        type: IntegrationType.LinkedAccount,
        teamId,
        ...(userId ? { userId } : {}),
      },
      include: this.authenticationInclude,
      transaction: options.transaction,
    })) as Integration<IntegrationType.LinkedAccount>[];

    return integrations.filter((integration) =>
      GitLabUtils.isSameInstance(integration.settings?.gitlab?.url, customUrl)
    );
  }

  /**
   * Removes linked accounts together with their stored tokens.
   *
   * @param linkedAccounts the linked account integrations to remove.
   * @param options the query options.
   */
  public static async destroyLinkedAccounts(
    linkedAccounts: Integration<IntegrationType.LinkedAccount>[],
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
   * Handles the accounts linked through a workspace integration whose OAuth
   * application can no longer be used, as it is being removed or replaced.
   * Tokens can only be refreshed with the application that issued them, so
   * each account is moved to another connected integration of the same
   * instance with that application, or removed when there is none. Accounts
   * linked through other connected integrations of the instance are not
   * affected. Those that did not record their integration, or whose
   * integration no longer exists, are refreshed through the oldest connected
   * integration of the instance, see unfurl, and are only affected when that
   * is this one.
   *
   * @param integration the workspace integration whose application is lost.
   * @param clientId the client id of the lost application, unset for the
   * application configured for GitLab Cloud.
   * @param options the query options.
   */
  public static async releaseLinkedAccounts(
    integration: Integration<IntegrationType.Embed>,
    clientId: string | null | undefined,
    options: { transaction?: Transaction } = {}
  ) {
    const url = integration.settings?.gitlab?.url;
    const others = (
      await this.findWorkspaceIntegrations(integration.teamId, options)
    ).filter(
      (other) =>
        other.id !== integration.id &&
        this.isConnected(other) &&
        GitLabUtils.isSameInstance(other.settings?.gitlab?.url, url)
    );
    const replacement = others.find(
      (other) => (other.authentication?.clientId ?? null) === (clientId ?? null)
    );
    // The integration may already be removed or still being connected, in
    // which case it is not among the connected ones, so it is placed in the
    // same order as the query. An integration being connected never issued
    // tokens.
    const [oldest] = sortBy(
      [...others, ...(this.isConnected(integration) ? [integration] : [])],
      ["createdAt", "id"]
    );
    const linkedAccounts = await this.findLinkedAccounts(
      { teamId: integration.teamId, customUrl: url },
      options
    );

    const removed: Integration<IntegrationType.LinkedAccount>[] = [];
    for (const linkedAccount of linkedAccounts) {
      const integrationId = linkedAccount.settings?.gitlab?.integrationId;
      const linkedThrough =
        integrationId === integration.id
          ? integration
          : (others.find((other) => other.id === integrationId) ?? oldest);
      // Without any connected integration left the token cannot be used, so
      // it is removed rather than left behind.
      if (linkedThrough && linkedThrough.id !== integration.id) {
        continue;
      }

      const gitlab = linkedAccount.settings?.gitlab;
      if (replacement && gitlab) {
        await linkedAccount.update(
          {
            settings: {
              ...linkedAccount.settings,
              gitlab: { ...gitlab, integrationId: replacement.id },
            },
          },
          { transaction: options.transaction }
        );
      } else {
        removed.push(linkedAccount);
      }
    }

    await this.destroyLinkedAccounts(removed, options);
  }

  /**
   * Reads the first value of a request header.
   *
   * @param headers the request headers.
   * @param name the lowercase name of the header.
   * @returns the header value, if any.
   */
  public static getHeader(
    headers: Record<string, unknown>,
    name: string
  ): string | undefined {
    const header = headers[name];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === "string" ? value : undefined;
  }

  /**
   * Finds the GitLab account a user linked for a GitLab instance.
   *
   * @param user the user that linked the account.
   * @param customUrl the instance URL, gitlab.com when unset.
   * @returns the linked account integration with its authentication, if any.
   */
  public static async findLinkedAccount(user: User, customUrl?: string) {
    const integrations = await this.findLinkedAccounts({
      teamId: user.teamId,
      userId: user.id,
      customUrl,
    });

    return integrations.find((integration) => integration.authentication);
  }

  /**
   * Unfurls a GitLab resource with the access of the given user. Only the
   * user's own linked account is used, so the result never reveals more than
   * the user can see in GitLab themselves.
   *
   * @param url GitLab resource url
   * @param actor User attempting to unfurl resource url
   * @returns An object containing resource details e.g, a GitLab Merge Request
   * details, an error when the URL belongs to GitLab but cannot be unfurled for
   * the user, or undefined when the URL does not belong to GitLab.
   */
  public static unfurl: UnfurlSignature = async (url: string, actor: User) => {
    const allIntegrations = await this.findWorkspaceIntegrations(actor.teamId);
    const workspaceIntegrations = allIntegrations.filter((integration) =>
      this.isConnected(integration)
    );

    let workspaceIntegration: Integration<IntegrationType.Embed> | undefined;
    let resource: ReturnType<typeof GitLabUtils.parseUrl>;

    for (const integration of workspaceIntegrations) {
      resource = GitLabUtils.parseUrl(url, integration.settings?.gitlab?.url);
      if (resource) {
        workspaceIntegration = integration;
        break;
      }
    }

    if (!resource || !workspaceIntegration) {
      // Other URLs on a connected instance, such as commits or files, and all
      // URLs on an instance that is still being connected or is only known
      // through GITLAB_URL, are not passed on to later unfurl providers, which
      // may be external services.
      const instanceUrls = [
        ...allIntegrations.map(
          (integration) => integration.settings?.gitlab?.url
        ),
        ...(env.GITLAB_URL ? [env.GITLAB_URL] : []),
      ];
      if (
        instanceUrls.some((instanceUrl) =>
          GitLabUtils.isInstanceUrl(url, instanceUrl)
        )
      ) {
        return { error: "Unsupported GitLab URL" };
      }
      return;
    }

    const customUrl = workspaceIntegration.settings?.gitlab?.url;
    const linkedAccount = await this.findLinkedAccount(actor, customUrl);

    if (!linkedAccount) {
      Logger.debug(
        "plugins",
        `No linked GitLab account found for user ${actor.id}`
      );
      return { error: "GitLab account not linked" };
    }

    // A token can only be refreshed with the OAuth application that issued it,
    // which is the one of the integration the account was linked through.
    // Accounts linked by an earlier version did not record it.
    const appIntegration =
      workspaceIntegrations.find(
        (integration) =>
          integration.id === linkedAccount.settings?.gitlab?.integrationId
      ) ?? workspaceIntegration;

    try {
      const { authentication } = linkedAccount;
      const appAuthentication = appIntegration.authentication;
      const token = await authentication.refreshTokenIfNeeded(
        async (refreshToken: string) =>
          GitLab.refreshToken({
            refreshToken,
            customUrl,
            clientId: appAuthentication?.clientId ?? undefined,
            clientSecret: appAuthentication?.clientSecret ?? undefined,
          })
      );

      // Epics are group-scoped, so they have no project path.
      if (
        resource.type === UnfurlResourceType.Issue &&
        resource.scope === "group"
      ) {
        const epic = await this.getEpic(
          token,
          resource.owner,
          resource.id,
          customUrl
        );

        return this.transformIssue(epic);
      }

      const projectPath = `${resource.owner}/${resource.repo}`;

      if (resource.type === UnfurlResourceType.Issue) {
        const issue = await this.getIssue(
          token,
          projectPath,
          resource.id,
          customUrl
        );

        return this.transformIssue(issue);
      } else if (resource.type === UnfurlResourceType.PR) {
        const mr = await this.getMergeRequest(
          token,
          projectPath,
          resource.id,
          customUrl
        );
        return this.transformMR(mr);
      } else if (resource.type === UnfurlResourceType.Project) {
        const client = await this.createClient(token, customUrl);
        const [project, issueStats] = await Promise.all([
          client.Projects.show(projectPath),
          client.IssuesStatistics.all({ projectId: projectPath }),
        ]);
        return this.transformProject(project, issueStats);
      }

      return { error: "Resource not found" };
    } catch (err) {
      Logger.warn("Failed to fetch resource from GitLab", toError(err));
      return {
        error: errToString(err) || "Unknown error",
      };
    }
  };

  /**
   * Exchanges an authorization code for an access token.
   *
   * @param params.code - The authorization code from the OAuth callback.
   * @param params.customUrl - Optional custom GitLab URL. Falls back to default.
   * @param params.clientId - Optional custom client ID (falls back to env var).
   * @param params.clientSecret - Optional custom client secret (falls back to env var).
   * @returns The parsed access token response.
   */
  public static oauthAccess = async ({
    code,
    customUrl,
    clientId,
    clientSecret,
  }: {
    code?: string | null;
    customUrl?: string;
    clientId?: string;
    clientSecret?: string;
  }) => {
    const url = customUrl || GitLabUtils.defaultGitlabUrl;
    const res = await fetch(GitLabUtils.getOauthUrl(url) + "/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        client_id: clientId || this.clientId,
        client_secret: clientSecret || this.clientSecret,
        grant_type: "authorization_code",
        redirect_uri: GitLabUtils.callbackUrl(),
      }),
    });

    if (res.status !== 200) {
      throw new Error(
        `Error while validating oauth code from GitLab; status: ${res.status}`
      );
    }

    return AccessTokenResponseSchema.parse(await res.json());
  };

  private static async refreshToken({
    refreshToken,
    customUrl,
    clientId,
    clientSecret,
  }: {
    refreshToken: string;
    customUrl?: string;
    clientId?: string;
    clientSecret?: string;
  }) {
    const queryParams = new URLSearchParams({
      client_id: clientId || this.clientId!,
      client_secret: clientSecret || this.clientSecret!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      redirect_uri: GitLabUtils.callbackUrl(),
    });

    const res = await fetch(
      `${GitLabUtils.getOauthUrl(customUrl)}/token?${queryParams.toString()}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }
    );
    const resJson = await res.json();
    if (res.status !== 200) {
      Logger.error("failed to refresh access token from GitLab", resJson);
      throw new Error(
        `Error while refreshing access token from GitLab; status: ${res.status}`
      );
    }

    return AccessTokenResponseSchema.parse(resJson);
  }

  private static transformIssue(
    issue: IssueSchemaWithExpandedLabels | EpicSchema
  ) {
    const labels: (string | SimpleLabelSchema)[] = issue.labels;

    return {
      type: UnfurlResourceType.Issue,
      url: issue.web_url,
      id: `#${issue.iid}`,
      title: issue.title,
      description: GitLabUtils.sanitizeGitLabMarkdown(issue.description),
      author: {
        name: issue.author?.username ?? "",
        avatarUrl: issue.author?.avatar_url ?? "",
      },
      // Epics are returned without label color details.
      labels: labels.map((label) =>
        typeof label === "string"
          ? { name: label, color: GitLabUtils.defaultLabelColor }
          : { name: label.name, color: label.color }
      ),
      state: {
        name: issue.state,
        color: GitLabUtils.getColorForStatus(issue.state),
      },
      createdAt: issue.created_at,
    } satisfies UnfurlIssueOrPR;
  }

  private static transformMR(mr: MergeRequestSchema) {
    const mrState = mr.merged_at ? "merged" : mr.state;
    return {
      type: UnfurlResourceType.PR,
      url: mr.web_url,
      id: `!${mr.iid}`,
      title: mr.title,
      description: GitLabUtils.sanitizeGitLabMarkdown(mr.description) ?? "",
      author: {
        name: mr.author.username,
        avatarUrl: mr.author.avatar_url,
      },
      state: {
        name: mrState,
        color: GitLabUtils.getColorForStatus(mrState, !!mr.draft),
        draft: mr.draft,
      },
      createdAt: mr.created_at,
    } satisfies UnfurlIssueOrPR;
  }

  private static transformProject(
    project: ProjectSchema,
    issueStats: StatisticsSchema
  ) {
    const visibility = project.visibility ?? "private";
    const owner = project.owner as
      | { name: string; avatar_url?: string }
      | undefined;
    const { opened, closed } = issueStats.statistics.counts;
    const total = opened + closed;
    const progress = total > 0 ? closed / total : 0;

    return {
      type: UnfurlResourceType.Project,
      url: project.web_url,
      id: String(project.id),
      name: project.name,
      color: GitLabUtils.getColorForProject(project.id),
      avatarUrl: project.avatar_url || undefined,
      description: GitLabUtils.sanitizeGitLabMarkdown(project.description),
      lead: owner
        ? {
            name: owner.name,
            avatarUrl: owner.avatar_url ?? "",
          }
        : null,
      state: {
        type: visibility,
        name: visibility.charAt(0).toUpperCase() + visibility.slice(1),
        color: GitLabUtils.getColorForVisibility(visibility),
      },
      labels: (project.topics ?? []).map((topic: string) => ({
        name: topic,
        color: GitLabUtils.defaultLabelColor,
      })),
      progress,
      createdAt: project.created_at,
      targetDate: null,
    } satisfies UnfurlProject;
  }
}
