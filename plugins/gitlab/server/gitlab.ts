import { sortBy } from "es-toolkit";
import type { Transaction } from "sequelize";
import z from "zod";
import {
  IntegrationService,
  IntegrationType,
  UnfurlResourceType,
} from "@shared/types";
import { toError, errToString } from "@shared/utils/error";
import { Second } from "@shared/utils/time";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import { Integration, IntegrationAuthentication } from "@server/models";
import type {
  UnfurlIssueOrPR,
  UnfurlProject,
  UnfurlSignature,
} from "@server/types";
import fetch from "@server/utils/fetch";
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

const UserSchema = z.object({
  id: z.number(),
  username: z.string(),
  avatar_url: z.string().nullish(),
});

const LabelSchema = z.object({
  name: z.string(),
  color: z.string(),
});

const IssueSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  web_url: z.string(),
  state: z.string(),
  author: UserSchema.nullish(),
  labels: z.array(LabelSchema),
  created_at: z.string(),
});

// Epics are returned without label color details.
const EpicSchema = IssueSchema.extend({
  labels: z.array(z.string()),
});

const MergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullish(),
  web_url: z.string(),
  state: z.string(),
  author: UserSchema,
  draft: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  created_at: z.string(),
});

const ProjectSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullish(),
  web_url: z.string(),
  avatar_url: z.string().nullish(),
  visibility: z.string().nullish(),
  owner: z
    .object({ name: z.string(), avatar_url: z.string().nullish() })
    .nullish(),
  topics: z.array(z.string()).nullish(),
  created_at: z.string(),
});

const IssueStatisticsSchema = z.object({
  statistics: z.object({
    counts: z.object({
      opened: z.number(),
      closed: z.number(),
    }),
  }),
});

type Issue = z.infer<typeof IssueSchema>;
type Epic = z.infer<typeof EpicSchema>;
type MergeRequest = z.infer<typeof MergeRequestSchema>;
type Project = z.infer<typeof ProjectSchema>;
type IssueStatistics = z.infer<typeof IssueStatisticsSchema>;

interface RequestParams {
  accessToken: string;
  customUrl?: string;
}

interface ResourceParams extends RequestParams {
  path: string;
  id: number;
}

export class GitLab {
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
   * Fetches an issue from a GitLab project.
   *
   * @param params.accessToken - The access token for authentication.
   * @param params.customUrl - Optional custom GitLab URL from integration settings.
   * @param params.path - The project path (owner/repo).
   * @param params.id - The issue IID (internal ID within the project).
   * @returns The issue data.
   * @throws If the issue does not exist.
   */
  public static async getIssue({ path, id, ...params }: ResourceParams) {
    const { data } = await this.request({
      ...params,
      path: `/projects/${encodeURIComponent(path)}/issues?iids[]=${id}&with_labels_details=true`,
      schema: z.array(IssueSchema),
    });

    if (data.length === 0) {
      throw new Error(`Issue ${id} not found in project ${path}`);
    }

    return data[0];
  }

  /**
   * Fetches an epic from a GitLab group.
   *
   * @param params.accessToken - The access token for authentication.
   * @param params.customUrl - Optional custom GitLab URL from integration settings.
   * @param params.path - The full path of the group.
   * @param params.id - The epic IID (internal ID within the group).
   * @returns The epic data.
   */
  public static async getEpic({ path, id, ...params }: ResourceParams) {
    const { data } = await this.request({
      ...params,
      path: `/groups/${encodeURIComponent(path)}/epics/${id}`,
      schema: EpicSchema,
    });
    return data;
  }

  /**
   * Fetches a merge request from a GitLab project.
   *
   * @param params.accessToken - The access token for authentication.
   * @param params.customUrl - Optional custom GitLab URL from integration settings.
   * @param params.path - The project path (owner/repo).
   * @param params.id - The merge request IID (internal ID within the project).
   * @returns The merge request data.
   */
  public static async getMergeRequest({ path, id, ...params }: ResourceParams) {
    const { data } = await this.request({
      ...params,
      path: `/projects/${encodeURIComponent(path)}/merge_requests/${id}`,
      schema: MergeRequestSchema,
    });
    return data;
  }

  /**
   * Fetches a GitLab project and its issue statistics.
   *
   * @param params.accessToken - The access token for authentication.
   * @param params.customUrl - Optional custom GitLab URL from integration settings.
   * @param params.path - The project path (owner/repo).
   * @returns The project data and its issue statistics, if available.
   */
  public static async getProject({
    path,
    ...params
  }: RequestParams & { path: string }) {
    const projectPath = `/projects/${encodeURIComponent(path)}`;
    const [project, issueStats] = await Promise.all([
      this.request({ ...params, path: projectPath, schema: ProjectSchema }),
      // Statistics can be slow for projects with many issues, so they are optional.
      this.request({
        ...params,
        path: `${projectPath}/issues_statistics`,
        schema: IssueStatisticsSchema,
      }).catch(() => undefined),
    ]);

    return { project: project.data, issueStats: issueStats?.data };
  }

  /**
   * Fetches current user information.
   *
   * @param params.accessToken - Access token received from OAuth flow.
   * @param params.customUrl - Optional custom GitLab URL. Falls back to default.
   * @returns User information including the resolved URL.
   */
  public static async getCurrentUser(params: RequestParams) {
    const url = params.customUrl || GitLabUtils.defaultGitlabUrl;
    const { data } = await this.request({
      ...params,
      path: "/user",
      schema: UserSchema,
    });
    return { ...data, url };
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
      const accessToken = await authentication.refreshTokenIfNeeded(
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
        const epic = await this.getEpic({
          accessToken,
          customUrl,
          path: resource.owner,
          id: resource.id,
        });

        return this.transformIssue(epic);
      }

      const path = `${resource.owner}/${resource.repo}`;

      if (resource.type === UnfurlResourceType.Issue) {
        const issue = await this.getIssue({
          accessToken,
          customUrl,
          path,
          id: resource.id,
        });

        return this.transformIssue(issue);
      } else if (resource.type === UnfurlResourceType.PR) {
        const mr = await this.getMergeRequest({
          accessToken,
          customUrl,
          path,
          id: resource.id,
        });
        return this.transformMR(mr);
      } else if (resource.type === UnfurlResourceType.Project) {
        const { project, issueStats } = await this.getProject({
          accessToken,
          customUrl,
          path,
        });
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
  public static async oauthAccess({
    code,
    customUrl,
    clientId,
    clientSecret,
  }: {
    code?: string | null;
    customUrl?: string;
    clientId?: string;
    clientSecret?: string;
  }) {
    return this.requestToken(customUrl, {
      code: code ?? "",
      client_id: clientId || this.clientId || "",
      client_secret: clientSecret || this.clientSecret || "",
      grant_type: "authorization_code",
      redirect_uri: GitLabUtils.callbackUrl(),
    });
  }

  /** The time to wait for a response from a GitLab instance. */
  private static timeout = 10 * Second.ms;

  private static clientSecret = env.GITLAB_CLIENT_SECRET;

  private static clientId = env.GITLAB_CLIENT_ID;

  /**
   * Makes an authenticated GET request to the GitLab API.
   *
   * @param params.accessToken - The access token for authentication.
   * @param params.customUrl - Optional custom GitLab URL from integration settings.
   * @param params.path - The API path, starting with a slash.
   * @param params.schema - The schema to parse the response body with.
   * @returns The parsed body and the response headers.
   * @throws If the response status is not successful.
   */
  private static async request<T extends z.ZodType>({
    accessToken,
    customUrl,
    path,
    schema,
  }: RequestParams & { path: string; schema: T }) {
    const baseUrl = customUrl || GitLabUtils.defaultGitlabUrl;
    const res = await fetch(`${baseUrl}/api/v4${path}`, {
      timeout: this.timeout,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(
        `Error while requesting ${path} from GitLab; status: ${res.status}`
      );
    }

    // Read the body at once, a body left unread while awaiting other requests
    // can be closed early.
    return { data: schema.parse(await res.json()), headers: res.headers };
  }

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
    return this.requestToken(customUrl, {
      refresh_token: refreshToken,
      client_id: clientId || this.clientId || "",
      client_secret: clientSecret || this.clientSecret || "",
      grant_type: "refresh_token",
      redirect_uri: GitLabUtils.callbackUrl(),
    });
  }

  private static async requestToken(
    customUrl: string | undefined,
    body: Record<string, string>
  ) {
    const res = await fetch(`${GitLabUtils.getOauthUrl(customUrl)}/token`, {
      method: "POST",
      timeout: this.timeout,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status !== 200) {
      throw new Error(
        `Error while requesting access token from GitLab; status: ${res.status}`
      );
    }

    return AccessTokenResponseSchema.parse(await res.json());
  }

  private static transformIssue(issue: Issue | Epic) {
    const labels: (string | z.infer<typeof LabelSchema>)[] = issue.labels;

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

  private static transformMR(mr: MergeRequest) {
    const mrState = mr.merged_at ? "merged" : mr.state;
    const draft = !!mr.draft;

    return {
      type: UnfurlResourceType.PR,
      url: mr.web_url,
      id: `!${mr.iid}`,
      title: mr.title,
      description: GitLabUtils.sanitizeGitLabMarkdown(mr.description) ?? "",
      author: {
        name: mr.author.username,
        avatarUrl: mr.author.avatar_url ?? "",
      },
      state: {
        name: mrState,
        color: GitLabUtils.getColorForStatus(mrState, draft),
        draft,
      },
      createdAt: mr.created_at,
    } satisfies UnfurlIssueOrPR;
  }

  private static transformProject(
    project: Project,
    issueStats?: IssueStatistics
  ) {
    const visibility = project.visibility ?? "private";
    const { owner } = project;
    const counts = issueStats?.statistics.counts;
    let progress: number | undefined;

    if (counts) {
      const total = counts.opened + counts.closed;
      progress = total > 0 ? counts.closed / total : 0;
    }

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
      labels: (project.topics ?? []).map((topic) => ({
        name: topic,
        color: GitLabUtils.defaultLabelColor,
      })),
      progress,
      createdAt: project.created_at,
      targetDate: null,
    } satisfies UnfurlProject;
  }
}
