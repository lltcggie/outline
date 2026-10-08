import { truncate } from "es-toolkit/compat";
import { t } from "i18next";
import type { Transaction } from "sequelize";
import { z } from "zod";
import { IntegrationService, UnfurlResourceType } from "@shared/types";
import { parseISODate } from "@shared/utils/date";
import { errToString, toError } from "@shared/utils/error";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import type {
  UnfurlIssueOrPR,
  UnfurlProject,
  UnfurlSignature,
} from "@server/types";
import fetch from "@server/utils/fetch";
import { opts } from "@server/utils/i18n";
import {
  findLinkedAccounts,
  requestWithLinkedAccount,
} from "@server/utils/linkedAccount";
import {
  OAuthTokenError,
  parseOAuthTokenError,
} from "@server/utils/OAuthTokenError";
import type { AsanaResource } from "../shared/AsanaUtils";
import { AsanaUtils } from "../shared/AsanaUtils";
import env from "./env";

const requestTimeout = 10_000;
const maxDescriptionLength = 300;

// Punctuation that Markdown, or an extension of the editor such as highlights
// and emoji, gives a meaning anywhere in a line.
const markdownPunctuation = /[\\`*_~[\]<>|&=$:#]/g;

// Markers that only start a list at the beginning of a line, the rest of the
// block syntax starts with punctuation escaped above. A number is kept and
// the punctuation after it is escaped.
const markdownListMarker = /^(\d*)([+-]|[.)])/;

type AsanaTask = Extract<AsanaResource, { type: "task" }>;
type AsanaProject = Extract<AsanaResource, { type: "project" }>;

const AccessTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
});

const RefreshTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  // A new refresh token is not issued when refreshing.
  refresh_token: z.string().optional(),
});

const CurrentUserSchema = z.object({
  gid: z.string(),
  name: z.string(),
  email: z.string().nullish(),
  photo: z
    .object({ image_128x128: z.string().optional() })
    .nullable()
    .optional(),
});

const MembershipSchema = z.object({
  project: z
    .object({
      gid: z.string(),
      name: z.string(),
      color: z.string().nullish(),
    })
    .nullish(),
  section: z.object({ name: z.string() }).nullish(),
});

const TaskSchema = z.object({
  name: z.string(),
  notes: z.string().nullish(),
  completed: z.boolean(),
  due_on: z.string().nullable(),
  created_at: z.string(),
  assignee: z.object({ name: z.string() }).nullable(),
  // The name of the creator is only returned for the requesting user.
  created_by: z.object({ name: z.string().optional() }).nullish(),
  memberships: z.array(MembershipSchema),
});

type Membership = z.infer<typeof MembershipSchema>;
type ProjectMembership = Membership & {
  project: NonNullable<Membership["project"]>;
};

const ProjectSchema = z.object({
  gid: z.string(),
  name: z.string(),
  notes: z.string().nullable(),
  color: z.string().nullable(),
  archived: z.boolean(),
  created_at: z.string(),
  due_on: z.string().nullable(),
  owner: z.object({ name: z.string() }).nullable(),
});

const TaskCountsSchema = z.object({
  num_tasks: z.number(),
  num_completed_tasks: z.number(),
});

// The body of an error from the API, see
// https://developers.asana.com/docs/errors
const ApiErrorSchema = z.object({
  errors: z.array(z.object({ message: z.string() })),
});

/** An error response from Asana, with the status Asana responded with. */
export class AsanaApiError extends Error {
  constructor(
    public status: number,
    detail?: string
  ) {
    super(
      `Asana responded with status ${status}${detail ? `: ${detail}` : ""}`
    );
  }

  /**
   * Whether the request was refused because the access token lacks an OAuth
   * scope the endpoint requires, which is a configuration problem of the
   * application rather than a resource the user cannot see. Asana reports
   * this as 403 with a message naming the scopes, there is no error code.
   *
   * @returns true if a required scope is missing.
   */
  public get isMissingScope(): boolean {
    return this.status === 403 && /\bscopes?\b/i.test(this.message);
  }
}

/**
 * The Asana API on behalf of the users that linked their accounts: the OAuth
 * token exchange, the requests for tasks and projects, and the unfurling of
 * app.asana.com links with the access of the requesting user.
 */
export class Asana {
  /**
   * Exchanges an OAuth code for an access token.
   *
   * @param code the authorization code from the OAuth callback.
   * @returns the access token, its lifetime and a refresh token.
   */
  public static oauthAccess(code: string) {
    return this.tokenRequest(
      { grant_type: "authorization_code", code },
      AccessTokenResponseSchema
    );
  }

  /**
   * Obtains a new access token with a refresh token.
   *
   * @param refreshToken the refresh token issued when the account was linked.
   * @returns the new access token and its lifetime.
   */
  public static refreshToken(refreshToken: string) {
    return this.tokenRequest(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      RefreshTokenResponseSchema
    );
  }

  /**
   * Fetches the Asana account an access token belongs to.
   *
   * @param accessToken the access token.
   * @returns the account details.
   */
  public static getCurrentUser(accessToken: string) {
    return this.request(
      accessToken,
      "/users/me",
      ["name", "email", "photo.image_128x128"],
      CurrentUserSchema
    );
  }

  /**
   * Fetches a task.
   *
   * @param accessToken the access token of the user fetching the task.
   * @param gid the task gid.
   * @returns the task details.
   */
  public static getTask(accessToken: string, gid: string) {
    return this.request(
      accessToken,
      `/tasks/${gid}`,
      [
        "name",
        "notes",
        "completed",
        "due_on",
        "created_at",
        "assignee.name",
        "created_by.name",
        "memberships.project.gid",
        "memberships.project.name",
        "memberships.project.color",
        "memberships.section.name",
      ],
      TaskSchema
    );
  }

  /**
   * Fetches a project.
   *
   * @param accessToken the access token of the user fetching the project.
   * @param gid the project gid.
   * @returns the project details.
   */
  public static getProject(accessToken: string, gid: string) {
    return this.request(
      accessToken,
      `/projects/${gid}`,
      [
        "gid",
        "name",
        "notes",
        "color",
        "archived",
        "created_at",
        "due_on",
        "owner.name",
      ],
      ProjectSchema
    );
  }

  /**
   * Fetches the number of tasks in a project, and how many are completed.
   *
   * @param accessToken the access token of the user fetching the project.
   * @param gid the project gid.
   * @returns the task counts.
   */
  public static getProjectTaskCounts(accessToken: string, gid: string) {
    return this.request(
      accessToken,
      `/projects/${gid}/task_counts`,
      ["num_tasks", "num_completed_tasks"],
      TaskCountsSchema
    );
  }

  /**
   * Finds the Asana account a user linked. The same Asana account may be
   * linked by several users of a team, each user only ever gets their own.
   *
   * @param user the user that linked the account.
   * @param options.transaction the transaction to query within.
   * @param options.requireAuthentication whether an account whose
   * authentication is missing is left out, which is the default. Pass false
   * when linking, so that such an account can be replaced.
   * @returns the linked account integration with its authentication, or null
   * when the user has not linked an account.
   */
  public static async findLinkedAccount(
    user: User,
    {
      transaction,
      requireAuthentication = true,
    }: { transaction?: Transaction; requireAuthentication?: boolean } = {}
  ) {
    const integrations = await findLinkedAccounts(
      IntegrationService.Asana,
      { teamId: user.teamId, userId: user.id },
      { transaction }
    );
    return (
      integrations.find(
        (integration) => !requireAuthentication || integration.authentication
      ) ?? null
    );
  }

  /**
   * Unfurls an app.asana.com link with the access of the given user: a task
   * is shown as an issue with its completion state, and a project as a
   * project with its progress. Only the user's own linked account is used, so
   * the result never reveals more than the user can see in Asana themselves.
   *
   * @param url the pasted or hovered URL.
   * @param actor the Outline user requesting the preview.
   * @returns the resource details, an error when the URL belongs to Asana but
   * cannot be unfurled for the user, or undefined when it does not belong to
   * Asana.
   */
  public static unfurl: UnfurlSignature = async (url, actor) => {
    if (!actor || !AsanaUtils.isAsanaUrl(url)) {
      return undefined;
    }

    // Other URLs on Asana, such as the inbox or search, are not passed on to
    // later unfurl providers, which may be external services.
    const resource = AsanaUtils.parseUrl(url);
    if (!resource) {
      return { error: "Unsupported Asana URL" };
    }

    const linkedAccount = await this.findLinkedAccount(actor);
    if (!linkedAccount) {
      Logger.debug(
        "plugins",
        `No linked Asana account found for user ${actor.id}`
      );
      return { error: "Asana account not linked" };
    }

    try {
      // Asana reports a revoked refresh token as "invalid_grant", the default.
      const outcome = await requestWithLinkedAccount({
        linkedAccount,
        actor,
        refresh: (refreshToken) => this.refreshToken(refreshToken),
        isUnauthorized: (err) =>
          err instanceof AsanaApiError && err.status === 401,
        request: (token) => this.unfurlResource(url, token, resource, actor),
      });
      if (outcome.removed) {
        return { error: "Asana account not linked" };
      }
      return outcome.result;
    } catch (err) {
      if (
        err instanceof AsanaApiError &&
        (err.status === 403 || err.status === 404)
      ) {
        if (err.isMissingScope) {
          // Every preview fails the same way until the application or
          // ASANA_OAUTH_SCOPES is corrected, so this must not stay hidden
          // among the resources users simply cannot see.
          Logger.warn(
            "Asana refused the request for a missing OAuth scope, check ASANA_OAUTH_SCOPES and the scopes of the OAuth application",
            toError(err)
          );
        } else {
          // Not visible to the user, or not a task or project after all.
          Logger.debug(
            "plugins",
            `Asana ${resource.type} ${resource.gid} is not visible to user ${actor.id} (${err.status})`
          );
        }
        return { error: "Resource not found" };
      }

      // A refresh that Asana refused for a reason other than a revoked token,
      // such as "invalid_client", is a problem of the installation rather than
      // of the resource.
      if (err instanceof OAuthTokenError) {
        Logger.error(
          "Asana refused to refresh an access token, check ASANA_CLIENT_ID and ASANA_CLIENT_SECRET",
          err
        );
        return { error: errToString(err) };
      }

      Logger.warn("Failed to fetch resource from Asana", toError(err));
      return { error: errToString(err) || "Unknown error" };
    }
  };

  private static unfurlResource(
    url: string,
    token: string,
    resource: AsanaResource,
    actor: User
  ): Promise<UnfurlIssueOrPR | UnfurlProject> {
    return resource.type === "task"
      ? this.unfurlTask(url, token, resource, actor)
      : this.unfurlProject(url, token, resource, actor);
  }

  private static async unfurlTask(
    url: string,
    token: string,
    resource: AsanaTask,
    actor: User
  ): Promise<UnfurlIssueOrPR> {
    const task = await this.getTask(token, resource.gid);
    const lng = opts(actor);

    // Prefer the project the link was copied from; a task can live in several.
    const memberships = task.memberships.filter(
      (membership): membership is ProjectMembership => !!membership.project
    );
    const membership =
      memberships.find((m) => m.project.gid === resource.projectGid) ??
      memberships.find((m) => m.section) ??
      memberships[0];
    const section = membership?.section?.name ?? "";

    // The due date is written out the way the actor prefers to see dates,
    // falling back to Asana's own value when it cannot be parsed. It is a
    // calendar date without a time or zone that parseISODate resolves to the
    // process's local midnight, so it is read back in that same zone rather
    // than the actor's, where it could land on the previous day.
    const dueDate = task.due_on ? parseISODate(task.due_on) : null;
    const due = dueDate
      ? actor.dateTimeFormatter.formatDate(dueDate, {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
      : task.due_on;

    // The line is rendered as Markdown together with the notes, so it is
    // escaped as a whole: the translation and the date are not trusted to be
    // free of punctuation any more than the name is.
    const details = this.escapeMarkdown(
      [
        task.assignee
          ? t("Assigned to {{ name }}", { name: task.assignee.name, ...lng })
          : null,
        due ? t("Due {{ date }}", { date: due, ...lng }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    );

    return {
      type: UnfurlResourceType.Issue,
      url,
      // Tasks have no short identifier, the section takes its place next to
      // the name, e.g. "Task name  In progress".
      id: env.ASANA_SHOW_SECTION ? section : "",
      title: task.name,
      description:
        [details, this.formatNotes(task.notes)].filter(Boolean).join("\n\n") ||
        null,
      author: {
        name: task.created_by?.name ?? "",
        avatarUrl: "",
      },
      labels: memberships.map((m) => ({
        name: m.section
          ? `${m.project.name} / ${m.section.name}`
          : m.project.name,
        color: AsanaUtils.getColorForProject(m.project.color),
      })),
      state: task.completed
        ? {
            type: "completed",
            name: t("Completed", lng),
            color: AsanaUtils.completedColor,
          }
        : {
            type: "incomplete",
            name: t("Incomplete", lng),
            color: AsanaUtils.incompleteColor,
          },
      createdAt: task.created_at,
    } satisfies UnfurlIssueOrPR;
  }

  private static async unfurlProject(
    url: string,
    token: string,
    resource: AsanaProject,
    actor: User
  ): Promise<UnfurlProject> {
    const lng = opts(actor);
    const project = await this.getProject(token, resource.gid);

    // The task counts have a stricter rate limit than other requests, so they
    // are only asked for once the project itself could be fetched, which also
    // keeps a retry with a refreshed token from asking twice. The progress is
    // only an extra, so the project is shown without it when they cannot be
    // fetched.
    const counts = await this.getProjectTaskCounts(token, resource.gid).catch(
      (err) => {
        Logger.debug(
          "plugins",
          `Task counts of Asana project ${resource.gid} are unavailable: ${errToString(err)}`
        );
        return undefined;
      }
    );

    return {
      type: UnfurlResourceType.Project,
      url,
      // Projects have no short identifier that is meaningful to users, and
      // the gid would be shown in place of the progress when that is missing.
      id: "",
      name: project.name,
      color: AsanaUtils.getColorForProject(project.color),
      description: this.formatNotes(project.notes) || null,
      lead: project.owner ? { name: project.owner.name, avatarUrl: "" } : null,
      state: project.archived
        ? {
            type: "archived",
            name: t("Archived", lng),
            color: AsanaUtils.incompleteColor,
          }
        : {
            type: "active",
            name: t("Active", lng),
            color: AsanaUtils.completedColor,
          },
      labels: [],
      progress: counts
        ? counts.num_tasks > 0
          ? counts.num_completed_tasks / counts.num_tasks
          : 0
        : undefined,
      createdAt: project.created_at,
      targetDate: project.due_on,
    } satisfies UnfurlProject;
  }

  /**
   * Prepares the notes of a task or project for display in a preview, which
   * renders descriptions as Markdown. Asana's notes are plain text, so they
   * are cut off when too long and then escaped so that they are shown as
   * written, with their line breaks.
   *
   * @param notes the notes, if any.
   * @returns the notes as Markdown, empty when there are none.
   */
  private static formatNotes(notes: string | null | undefined): string {
    const truncated = truncate((notes ?? "").trim(), {
      length: maxDescriptionLength,
      omission: "…",
    });
    return this.escapeMarkdown(truncated);
  }

  /**
   * Escapes plain text so that Markdown renders it as written. Blank lines
   * separate paragraphs, any other line break becomes a hard break, and lines
   * are not indented as that would start a code block.
   *
   * @param text the plain text.
   * @returns the text as Markdown.
   */
  private static escapeMarkdown(text: string): string {
    return text
      .replace(/\r\n?/g, "\n")
      .split(/\n{2,}/)
      .map((paragraph) =>
        paragraph
          .split("\n")
          .map((line) =>
            line
              .trim()
              .replace(markdownPunctuation, "\\$&")
              .replace(markdownListMarker, "$1\\$2")
          )
          .join("  \n")
      )
      .join("\n\n");
  }

  /**
   * Requests a token from Asana's OAuth endpoint on behalf of the application.
   *
   * @param params the grant parameters, such as the code or refresh token.
   * @param schema the schema of the expected response.
   * @returns the parsed response.
   * @throws {OAuthTokenError} when Asana refuses the grant, with the code
   * "invalid_grant" when the code or refresh token is no longer valid.
   * @throws {AsanaApiError} when Asana does not issue a token for another
   * reason.
   */
  private static async tokenRequest<T>(
    params: Record<string, string>,
    schema: z.ZodType<T>
  ): Promise<T> {
    const res = await fetch(AsanaUtils.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: env.ASANA_CLIENT_ID ?? "",
        client_secret: env.ASANA_CLIENT_SECRET ?? "",
        redirect_uri: AsanaUtils.callbackUrl(),
        ...params,
      }),
      timeout: requestTimeout,
    });

    if (res.status !== 200) {
      const body = await res.text();
      throw (
        parseOAuthTokenError("Asana", body) ??
        new AsanaApiError(
          res.status,
          `error requesting ${params.grant_type} token, ${body}`
        )
      );
    }

    return schema.parse(await res.json());
  }

  /**
   * Parses a response body against a schema without throwing, for error
   * bodies that may not be JSON at all.
   *
   * @param body the response body.
   * @param schema the schema of the expected body.
   * @returns the parsed body, or undefined when it does not match.
   */
  private static parseJson<T>(body: string, schema: z.ZodType<T>) {
    try {
      const result = schema.safeParse(JSON.parse(body));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Performs a request against the Asana API, asking for the given fields
   * only.
   *
   * @param accessToken the access token to authenticate with.
   * @param path the API path, e.g. "/tasks/123".
   * @param fields the fields to include in the response.
   * @param schema the schema of the data in the response.
   * @returns the data of the response.
   * @throws {AsanaApiError} when Asana responds with an error status.
   */
  private static async request<T>(
    accessToken: string,
    path: string,
    fields: string[],
    schema: z.ZodType<T>
  ): Promise<T> {
    const res = await fetch(
      `${AsanaUtils.apiUrl}${path}?opt_fields=${encodeURIComponent(fields.join(","))}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        timeout: requestTimeout,
      }
    );

    if (!res.ok) {
      // The message tells a missing scope apart from a hidden resource.
      const body = await res.text();
      throw new AsanaApiError(
        res.status,
        this.parseJson(body, ApiErrorSchema)?.errors[0]?.message
      );
    }

    return z.object({ data: schema }).parse(await res.json()).data;
  }
}
