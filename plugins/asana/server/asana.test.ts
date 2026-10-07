// @vitest-isolate true
import { http, HttpResponse } from "msw";
import {
  IntegrationService,
  IntegrationType,
  UnfurlResourceType,
} from "@shared/types";
import Logger from "@server/logging/Logger";
import { Event, Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import { buildUser } from "@server/test/factories";
import { server } from "@server/test/msw";
import { initI18n } from "@server/utils/i18n";
import { AsanaUtils } from "../shared/AsanaUtils";
import { Asana, AsanaApiError } from "./asana";
import env from "./env";

const taskUrl =
  "https://app.asana.com/1/1209288636362503/project/1209325819715595/task/1209400000000001";
const projectUrl =
  "https://app.asana.com/1/1209288636362503/project/1209325819715595/list/1209328572071561";

const task = {
  name: "Secret task",
  notes: "Secret notes",
  completed: false,
  due_on: "2026-10-31",
  created_at: "2026-10-01T00:00:00.000Z",
  assignee: { name: "Alice" },
  created_by: { name: "Bob" },
  memberships: [
    {
      project: {
        gid: "1209325819715596",
        name: "Other project",
        color: "light-blue",
      },
      section: { name: "Backlog" },
    },
    {
      project: { gid: "1209325819715595", name: "Project", color: "dark-pink" },
      section: { name: "In progress" },
    },
  ],
};

const project = {
  gid: "1209325819715595",
  name: "Project",
  notes: "Notes",
  color: "dark-pink",
  archived: false,
  created_at: "2026-09-01T00:00:00.000Z",
  due_on: "2026-12-31",
  owner: { name: "Carol" },
};

/**
 * Links an Asana account for a user.
 *
 * @param user the user linking the account.
 * @param options.expired whether the token has expired and must be refreshed.
 * @returns the linked account integration.
 */
async function buildLinkedAccount(
  user: User,
  options: { expired?: boolean } = {}
) {
  const authentication = await IntegrationAuthentication.create({
    service: IntegrationService.Asana,
    userId: user.id,
    teamId: user.teamId,
    token: `token-${user.id}`,
    refreshToken: `refresh-${user.id}`,
    expiresAt: options.expired ? new Date(0) : new Date(Date.now() + 3600_000),
  });
  return Integration.create<Integration<IntegrationType.LinkedAccount>>({
    service: IntegrationService.Asana,
    type: IntegrationType.LinkedAccount,
    userId: user.id,
    teamId: user.teamId,
    authenticationId: authentication.id,
    settings: { asana: { account: { id: "1", name: "a" } } },
  });
}

describe("Asana.unfurl", () => {
  // Previews contain text localized for the user.
  beforeAll(async () => {
    await initI18n();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should ignore URLs that are not on Asana", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    const getTask = vi.spyOn(Asana, "getTask").mockResolvedValue(task);

    expect(
      await Asana.unfurl("https://example.com/0/1/2", user)
    ).toBeUndefined();
    expect(getTask).not.toHaveBeenCalled();
  });

  it("should not pass other Asana URLs on to later providers", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);

    expect(
      await Asana.unfurl("https://app.asana.com/0/inbox/1209288636362503", user)
    ).toHaveProperty("error");
  });

  it("should not unfurl without a linked account", async () => {
    const user = await buildUser();
    const getTask = vi.spyOn(Asana, "getTask").mockResolvedValue(task);

    expect(await Asana.unfurl(taskUrl, user)).toHaveProperty("error");
    expect(getTask).not.toHaveBeenCalled();
  });

  it("should not use another user's linked account", async () => {
    const user = await buildUser();
    const other = await buildUser({ teamId: user.teamId });
    await buildLinkedAccount(other);
    const getTask = vi.spyOn(Asana, "getTask").mockResolvedValue(task);

    expect(await Asana.unfurl(taskUrl, user)).toHaveProperty("error");
    expect(getTask).not.toHaveBeenCalled();
  });

  it("should unfurl a task as an issue with the user's own token", async () => {
    // A zone behind the process's (UTC): the due date must not slip a day.
    const user = await buildUser({ timezone: "America/Los_Angeles" });
    const other = await buildUser({ teamId: user.teamId });
    await buildLinkedAccount(user);
    await buildLinkedAccount(other);
    const getTask = vi.spyOn(Asana, "getTask").mockResolvedValue(task);

    const result = await Asana.unfurl(taskUrl, user);
    expect(getTask).toHaveBeenCalledWith(
      `token-${user.id}`,
      "1209400000000001"
    );
    expect(result).toEqual({
      type: UnfurlResourceType.Issue,
      url: taskUrl,
      // The section of the project in the URL is preferred.
      id: "In progress",
      title: "Secret task",
      // The due date is written out in the user's language and date format,
      // as the calendar date Asana gave rather than shifted to the user's zone.
      description: "Assigned to Alice · Due October 31, 2026\n\nSecret notes",
      author: { name: "Bob", avatarUrl: "" },
      labels: [
        { name: "Other project / Backlog", color: "#4573d2" },
        { name: "Project / In progress", color: "#e362e3" },
      ],
      state: {
        type: "incomplete",
        name: "Incomplete",
        color: AsanaUtils.incompleteColor,
      },
      createdAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("should show a completed task without details", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getTask").mockResolvedValue({
      ...task,
      notes: "",
      completed: true,
      assignee: null,
      due_on: null,
      created_by: null,
      memberships: [],
    });

    const result = await Asana.unfurl(taskUrl, user);
    expect(result).toMatchObject({
      id: "",
      title: "Secret task",
      description: null,
      author: { name: "" },
      labels: [],
      state: { type: "completed", name: "Completed" },
    });
  });

  it("should shorten long notes to the description limit", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getTask").mockResolvedValue({
      ...task,
      notes: "x".repeat(301),
      assignee: null,
      due_on: null,
    });

    // The omission counts towards the limit, so the result is 300 characters.
    expect(await Asana.unfurl(taskUrl, user)).toMatchObject({
      description: `${"x".repeat(299)}…`,
    });
  });

  it("should show plain text notes as written", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getTask").mockResolvedValue({
      ...task,
      notes:
        "Price is *net*, see #123 and __init__\r\n- not a list\n  1. nor this\n\n<b>tag</b> a | b",
      assignee: { name: "alice_b" },
      due_on: null,
    });

    // Descriptions are rendered as Markdown, so punctuation is escaped and
    // single line breaks become hard breaks instead of being joined.
    expect(await Asana.unfurl(taskUrl, user)).toMatchObject({
      description:
        "Assigned to alice\\_b\n\n" +
        "Price is \\*net\\*, see \\#123 and \\_\\_init\\_\\_  \n" +
        "\\- not a list  \n" +
        "1\\. nor this\n\n" +
        "\\<b\\>tag\\</b\\> a \\| b",
    });
  });

  it("should escape the notes after shortening them", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getTask").mockResolvedValue({
      ...task,
      notes: "*".repeat(301),
      assignee: null,
      due_on: null,
    });

    // The escaping does not count towards the limit.
    expect(await Asana.unfurl(taskUrl, user)).toMatchObject({
      description: `${"\\*".repeat(299)}…`,
    });
  });

  it("should leave the section out when disabled", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getTask").mockResolvedValue(task);
    const original = env.ASANA_SHOW_SECTION;
    env.ASANA_SHOW_SECTION = false;

    try {
      expect(await Asana.unfurl(taskUrl, user)).toMatchObject({ id: "" });
    } finally {
      env.ASANA_SHOW_SECTION = original;
    }
  });

  it("should unfurl a project with its progress", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    const getProject = vi.spyOn(Asana, "getProject").mockResolvedValue(project);
    const getCounts = vi
      .spyOn(Asana, "getProjectTaskCounts")
      .mockResolvedValue({ num_tasks: 4, num_completed_tasks: 1 });

    const result = await Asana.unfurl(projectUrl, user);
    expect(getProject).toHaveBeenCalledWith(
      `token-${user.id}`,
      "1209325819715595"
    );
    expect(getCounts).toHaveBeenCalledWith(
      `token-${user.id}`,
      "1209325819715595"
    );
    expect(result).toEqual({
      type: UnfurlResourceType.Project,
      url: projectUrl,
      id: "",
      name: "Project",
      color: "#e362e3",
      description: "Notes",
      lead: { name: "Carol", avatarUrl: "" },
      state: {
        type: "active",
        name: "Active",
        color: AsanaUtils.completedColor,
      },
      labels: [],
      progress: 0.25,
      createdAt: "2026-09-01T00:00:00.000Z",
      targetDate: "2026-12-31",
    });
  });

  it("should show an archived project without tasks", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getProject").mockResolvedValue({
      ...project,
      archived: true,
      notes: "",
      color: null,
      owner: null,
      due_on: null,
    });
    vi.spyOn(Asana, "getProjectTaskCounts").mockResolvedValue({
      num_tasks: 0,
      num_completed_tasks: 0,
    });

    expect(await Asana.unfurl(projectUrl, user)).toMatchObject({
      color: AsanaUtils.defaultProjectColor,
      description: null,
      lead: null,
      state: { type: "archived", name: "Archived" },
      progress: 0,
      targetDate: null,
    });
  });

  it("should not ask for the task counts until the project could be fetched", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "refreshToken").mockResolvedValue({
      access_token: "refreshed-token",
      expires_in: 3600,
    });
    const getProject = vi
      .spyOn(Asana, "getProject")
      .mockRejectedValueOnce(new AsanaApiError(401))
      .mockResolvedValueOnce(project);
    const getCounts = vi
      .spyOn(Asana, "getProjectTaskCounts")
      .mockResolvedValue({ num_tasks: 4, num_completed_tasks: 1 });

    expect(await Asana.unfurl(projectUrl, user)).toMatchObject({
      name: "Project",
      progress: 0.25,
    });
    expect(getProject).toHaveBeenCalledTimes(2);
    // The counts have a stricter rate limit, the attempt with the rejected
    // token must not have spent a request on them.
    expect(getCounts).toHaveBeenCalledTimes(1);
    expect(getCounts).toHaveBeenCalledWith(
      "refreshed-token",
      "1209325819715595"
    );
  });

  it("should show a project without progress when the task counts are unavailable", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getProject").mockResolvedValue(project);
    // The task counts have their own, stricter rate limit.
    vi.spyOn(Asana, "getProjectTaskCounts").mockRejectedValue(
      new AsanaApiError(429)
    );

    const result = await Asana.unfurl(projectUrl, user);
    expect(result).toMatchObject({
      type: UnfurlResourceType.Project,
      name: "Project",
    });
    expect(result).not.toHaveProperty("error");
    expect(result).toHaveProperty("progress", undefined);
  });

  it("should refresh the token and retry when Asana rejects it", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    const refreshToken = vi
      .spyOn(Asana, "refreshToken")
      .mockResolvedValue({ access_token: "refreshed-token", expires_in: 3600 });
    const getTask = vi
      .spyOn(Asana, "getTask")
      .mockRejectedValueOnce(new AsanaApiError(401))
      .mockResolvedValueOnce(task);

    const result = await Asana.unfurl(taskUrl, user);

    expect(result).toMatchObject({ title: "Secret task" });
    expect(refreshToken).toHaveBeenCalledWith(`refresh-${user.id}`);
    expect(getTask).toHaveBeenNthCalledWith(
      2,
      "refreshed-token",
      "1209400000000001"
    );
    const linkedAccount = await Asana.findLinkedAccount(user);
    expect(linkedAccount?.authentication.token).toEqual("refreshed-token");
  });

  it("should remove the linked account when the user revoked the application", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    vi.spyOn(Asana, "refreshToken").mockRejectedValue(
      new AsanaApiError(400, "invalid_grant", "invalid_grant")
    );
    const getTask = vi
      .spyOn(Asana, "getTask")
      .mockRejectedValue(new AsanaApiError(401));

    expect(await Asana.unfurl(taskUrl, user)).toEqual({
      error: "Asana account not linked",
    });
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(await Asana.findLinkedAccount(user)).toBeNull();

    // The account is deleted the same way as from the settings, with an event
    // whose processor clears the user's previews and removes the tokens.
    const deleted = await Integration.findByPk(linkedAccount.id, {
      paranoid: false,
    });
    expect(deleted?.deletedAt).toBeTruthy();
    expect(
      await Event.findOne({
        where: { name: "integrations.delete", modelId: linkedAccount.id },
      })
    ).not.toBeNull();
  });

  it("should keep the linked account when the OAuth application credentials are refused", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    const error = vi.spyOn(Logger, "error").mockImplementation(() => {});
    // A wrong ASANA_CLIENT_SECRET is refused with the same status as a
    // revoked refresh token, but with a different error code.
    vi.spyOn(Asana, "refreshToken").mockRejectedValue(
      new AsanaApiError(400, "invalid_client", "invalid_client")
    );
    vi.spyOn(Asana, "getTask").mockRejectedValue(new AsanaApiError(401));

    expect(await Asana.unfurl(taskUrl, user)).toHaveProperty("error");
    expect(await Asana.findLinkedAccount(user)).not.toBeNull();
    expect(
      await IntegrationAuthentication.count({
        where: { service: IntegrationService.Asana, userId: user.id },
      })
    ).toEqual(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("ASANA_CLIENT_SECRET"),
      expect.any(AsanaApiError)
    );
  });

  it("should keep the linked account when the refresh fails for another reason", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "refreshToken").mockRejectedValue(
      new Error("socket hang up")
    );
    vi.spyOn(Asana, "getTask").mockRejectedValue(new AsanaApiError(401));

    expect(await Asana.unfurl(taskUrl, user)).toHaveProperty("error");
    expect(await Asana.findLinkedAccount(user)).not.toBeNull();
  });

  it("should warn when the application lacks a required OAuth scope", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
    vi.spyOn(Asana, "getTask").mockRejectedValue(
      new AsanaApiError(
        403,
        "The following scopes must be present to fulfill this request: tasks:read"
      )
    );

    expect(await Asana.unfurl(taskUrl, user)).toEqual({
      error: "Resource not found",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ASANA_OAUTH_SCOPES"),
      expect.any(AsanaApiError)
    );
  });

  it("should not warn when the task is hidden from the user", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});
    vi.spyOn(Asana, "getTask").mockRejectedValue(
      new AsanaApiError(403, "You do not have access to this object")
    );

    expect(await Asana.unfurl(taskUrl, user)).toEqual({
      error: "Resource not found",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("should refresh an expired token", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user, { expired: true });
    const refreshToken = vi
      .spyOn(Asana, "refreshToken")
      .mockResolvedValue({ access_token: "refreshed-token", expires_in: 3600 });
    const getTask = vi.spyOn(Asana, "getTask").mockResolvedValue(task);

    await Asana.unfurl(taskUrl, user);

    expect(refreshToken).toHaveBeenCalledWith(`refresh-${user.id}`);
    expect(getTask).toHaveBeenCalledWith("refreshed-token", "1209400000000001");
  });

  it("should return an error when the task is not visible to the user", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(Asana, "getTask").mockRejectedValue(new AsanaApiError(404));

    expect(await Asana.unfurl(taskUrl, user)).toHaveProperty("error");
  });
});

// Requests to Asana are answered by msw, which the test setup registers for
// every server test and resets between tests.
describe("Asana requests", () => {
  it("should carry the OAuth error code of a refused token request", async () => {
    let grant: string | null = null;
    server.use(
      http.post(AsanaUtils.tokenUrl, async ({ request }) => {
        grant = new URLSearchParams(await request.text()).get("grant_type");
        return HttpResponse.json(
          {
            error: "invalid_client",
            error_description:
              "The client_id and client_secret must authorize the app",
          },
          { status: 400 }
        );
      })
    );

    await expect(Asana.refreshToken("refresh")).rejects.toMatchObject({
      status: 400,
      code: "invalid_client",
    });
    expect(grant).toEqual("refresh_token");
  });

  it("should not fail on a token error that is not JSON", async () => {
    server.use(
      http.post(
        AsanaUtils.tokenUrl,
        () => new HttpResponse("Bad Gateway", { status: 502 })
      )
    );

    await expect(Asana.refreshToken("refresh")).rejects.toMatchObject({
      status: 502,
      code: undefined,
    });
  });

  it("should recognize a missing scope in an API error", async () => {
    server.use(
      http.get(`${AsanaUtils.apiUrl}/projects/1`, () =>
        HttpResponse.json(
          {
            errors: [
              {
                message:
                  "The following scopes must be present to fulfill this request: projects:read",
                help: "For more information on API status codes and how to handle them, read the docs on errors: https://developers.asana.com/docs/errors",
              },
            ],
          },
          { status: 403 }
        )
      )
    );

    const promise = Asana.getProject("token", "1");
    await expect(promise).rejects.toBeInstanceOf(AsanaApiError);
    await expect(promise).rejects.toMatchObject({
      status: 403,
      isMissingScope: true,
    });
    await expect(promise).rejects.toThrow("projects:read");
  });

  it("should not take a hidden resource for a missing scope", async () => {
    server.use(
      http.get(`${AsanaUtils.apiUrl}/tasks/1`, () =>
        HttpResponse.json(
          { errors: [{ message: "You do not have access to this object" }] },
          { status: 403 }
        )
      )
    );

    await expect(Asana.getTask("token", "1")).rejects.toMatchObject({
      status: 403,
      isMissingScope: false,
    });
  });

  it("should return the data of a successful request", async () => {
    let authorization: string | null = null;
    let fields: string | null = null;
    server.use(
      http.get(`${AsanaUtils.apiUrl}/projects/1`, ({ request }) => {
        authorization = request.headers.get("authorization");
        fields = new URL(request.url).searchParams.get("opt_fields");
        return HttpResponse.json({ data: project });
      })
    );

    expect(await Asana.getProject("token", "1")).toEqual(project);
    expect(authorization).toEqual("Bearer token");
    expect(fields).toContain("owner.name");
  });
});
