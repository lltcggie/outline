// @vitest-isolate true
import { GitbeakerRequestError } from "@gitbeaker/rest";
import { http, HttpResponse } from "msw";
import { IntegrationService, IntegrationType } from "@shared/types";
import Logger from "@server/logging/Logger";
import { Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import { buildAdmin, buildUser } from "@server/test/factories";
import { sequelize } from "@server/storage/database";
import { server as msw } from "@server/test/msw";
import { getTestServer } from "@server/test/support";
import { OAuthTokenError } from "@server/utils/OAuthTokenError";
import Iframely from "plugins/iframely/server/iframely";
import { GitLabIssueProvider } from "./GitLabIssueProvider";
import env from "./env";
import { GitLab } from "./gitlab";
import { uninstall } from "./uninstall";

const server = getTestServer();
const gitlabUrl = "https://gitlab.example.com";
const issueUrl = `${gitlabUrl}/secret/p/-/issues/1`;
const tokenUrl = `${gitlabUrl}/oauth/token`;

const issue = {
  iid: 1,
  title: "Secret issue",
  description: "Secret body",
  web_url: issueUrl,
  state: "opened",
  labels: [],
  author: { username: "a", avatar_url: "" },
  created_at: new Date().toISOString(),
} as unknown as Awaited<ReturnType<typeof GitLab.getIssue>>;

const refreshed = {
  access_token: "refreshed-token",
  token_type: "Bearer",
  expires_in: 7200,
  refresh_token: "next-refresh-token",
  scope: "read_api read_user",
  created_at: 1_700_000_000,
};

/**
 * Creates an error as GitLab's client reports a refused request.
 *
 * @param status the status GitLab responded with.
 * @returns the error.
 */
function requestError(status: number) {
  return new GitbeakerRequestError(`GitLab responded with ${status}`, {
    cause: {
      description: `GitLab responded with ${status}`,
      request: new Request(`${gitlabUrl}/api/v4/x`),
      response: new Response(null, { status }),
    },
  });
}

/**
 * Creates a workspace integration for a self-managed instance.
 *
 * @param admin the admin that connects the instance.
 * @param clientId the client id of the OAuth application.
 * @returns the workspace integration.
 */
async function buildWorkspaceIntegration(admin: User, clientId = "client-id") {
  const authentication = await IntegrationAuthentication.create({
    service: IntegrationService.GitLab,
    userId: admin.id,
    teamId: admin.teamId,
    clientId,
    clientSecret: `${clientId}-secret`,
    // A token left behind by a legacy connection must never be used.
    token: "workspace-token",
  });
  return Integration.create({
    service: IntegrationService.GitLab,
    type: IntegrationType.Embed,
    userId: admin.id,
    teamId: admin.teamId,
    authenticationId: authentication.id,
    settings: { gitlab: { url: gitlabUrl } },
  });
}

/**
 * Links a GitLab account for a user.
 *
 * @param user the user linking the account.
 * @param options the options for the account.
 * @param options.integrationId the workspace integration it was linked through.
 * @param options.expired whether the token has expired and must be refreshed.
 * @returns the linked account integration.
 */
async function buildLinkedAccount(
  user: User,
  options: { integrationId?: string; expired?: boolean } = {}
) {
  const authentication = await IntegrationAuthentication.create({
    service: IntegrationService.GitLab,
    userId: user.id,
    teamId: user.teamId,
    token: `token-${user.id}`,
    refreshToken: `refresh-${user.id}`,
    expiresAt: options.expired ? new Date(0) : new Date(Date.now() + 3600_000),
  });
  return Integration.create<Integration<IntegrationType.LinkedAccount>>({
    service: IntegrationService.GitLab,
    type: IntegrationType.LinkedAccount,
    userId: user.id,
    teamId: user.teamId,
    authenticationId: authentication.id,
    settings: {
      gitlab: {
        url: gitlabUrl,
        integrationId: options.integrationId,
        account: { id: 1, name: "a", avatarUrl: "" },
      },
    },
  });
}

/**
 * Changes when an integration was created, which decides the order of
 * integrations that configure the same instance.
 *
 * @param integration the integration to change.
 * @param createdAt when the integration was created.
 */
async function setCreatedAt(integration: Integration, createdAt: Date) {
  await sequelize.query(
    `UPDATE integrations SET "createdAt" = :createdAt WHERE id = :id`,
    { replacements: { createdAt, id: integration.id } }
  );
  await integration.reload({ paranoid: false });
}

describe("GitLab.unfurl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should ignore URLs when GitLab is not connected", async () => {
    const user = await buildUser();
    expect(await GitLab.unfurl(issueUrl, user)).toBeUndefined();
  });

  it("should not unfurl an instance that is still being connected", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    await integration.update({
      settings: { gitlab: { url: gitlabUrl, pending: true } },
    });
    await buildLinkedAccount(admin);
    const getIssue = vi.spyOn(GitLab, "getIssue").mockResolvedValue(issue);

    // The URL is claimed, so that it is not passed on to later providers.
    expect(await GitLab.unfurl(issueUrl, admin)).toHaveProperty("error");
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("should not unfurl without a linked account", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    const getIssue = vi.spyOn(GitLab, "getIssue").mockResolvedValue(issue);

    const result = await GitLab.unfurl(issueUrl, admin);
    expect(result).toHaveProperty("error");
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("should unfurl with the user's own token", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });
    const other = await buildUser({ teamId: admin.teamId });
    await buildLinkedAccount(user);
    await buildLinkedAccount(other);
    const getIssue = vi.spyOn(GitLab, "getIssue").mockResolvedValue(issue);

    const result = await GitLab.unfurl(issueUrl, user);
    expect(result).toMatchObject({ title: "Secret issue" });
    expect(getIssue).toHaveBeenCalledWith(
      `token-${user.id}`,
      "secret/p",
      1,
      gitlabUrl
    );
  });

  it.each([0, 1])(
    "should refresh with the application the account was linked through (%i)",
    async (index) => {
      const admin = await buildAdmin();
      // A previous version could configure the same instance several times.
      const integrations = [
        await buildWorkspaceIntegration(admin, "client-a"),
        await buildWorkspaceIntegration(admin, "client-b"),
      ];
      await buildLinkedAccount(admin, {
        integrationId: integrations[index].id,
        expired: true,
      });
      const refreshToken = vi
        .spyOn(GitLab, "refreshToken")
        .mockResolvedValue(refreshed);
      const getIssue = vi.spyOn(GitLab, "getIssue").mockResolvedValue(issue);

      await GitLab.unfurl(issueUrl, admin);

      const clientId = index === 0 ? "client-a" : "client-b";
      expect(refreshToken).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshToken: `refresh-${admin.id}`,
          clientId,
          clientSecret: `${clientId}-secret`,
        })
      );
      expect(getIssue).toHaveBeenCalledWith(
        "refreshed-token",
        "secret/p",
        1,
        gitlabUrl
      );
    }
  );

  it("should return an error when GitLab denies access", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    const linked = await buildLinkedAccount(admin);
    vi.spyOn(GitLab, "getIssue").mockRejectedValue(requestError(404));
    const refreshToken = vi.spyOn(GitLab, "refreshToken");

    expect(await GitLab.unfurl(issueUrl, admin)).toHaveProperty("error");
    expect(refreshToken).not.toHaveBeenCalled();
    expect(await Integration.findByPk(linked.id)).not.toBe(null);
  });

  // The recovery itself is shared with the other integrations and tested
  // with server/utils/linkedAccount.ts, these check what GitLab passes to it.
  it("should refresh the token and retry when GitLab rejects it", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin, "client-a");
    const linked = await buildLinkedAccount(admin);
    const refreshToken = vi
      .spyOn(GitLab, "refreshToken")
      .mockResolvedValue(refreshed);
    const getIssue = vi
      .spyOn(GitLab, "getIssue")
      .mockRejectedValueOnce(requestError(401))
      .mockResolvedValueOnce(issue);

    const result = await GitLab.unfurl(issueUrl, admin);

    expect(result).toMatchObject({ title: "Secret issue" });
    // The refresh goes through the application the account was linked with.
    expect(refreshToken).toHaveBeenCalledExactlyOnceWith({
      refreshToken: `refresh-${admin.id}`,
      customUrl: gitlabUrl,
      clientId: "client-a",
      clientSecret: "client-a-secret",
    });
    expect(getIssue).toHaveBeenLastCalledWith(
      "refreshed-token",
      "secret/p",
      1,
      gitlabUrl
    );
    const authentication = await IntegrationAuthentication.findByPk(
      linked.authenticationId,
      { rejectOnEmpty: true }
    );
    expect(authentication.token).toEqual("refreshed-token");
    expect(authentication.refreshToken).toEqual("next-refresh-token");
  });

  it("should remove the linked account when the user revoked the application", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    const linked = await buildLinkedAccount(admin);
    // GitLab reports a revoked refresh token with the "invalid_grant" of RFC
    // 6749, which the shared recovery recognizes by itself.
    vi.spyOn(GitLab, "refreshToken").mockRejectedValue(
      new OAuthTokenError("GitLab", "invalid_grant")
    );
    const getIssue = vi
      .spyOn(GitLab, "getIssue")
      .mockRejectedValue(requestError(401));

    expect(await GitLab.unfurl(issueUrl, admin)).toEqual({
      error: "GitLab account not linked",
    });
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(await Integration.findByPk(linked.id)).toBe(null);
  });

  it("should keep the linked account when the OAuth application credentials are refused", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    const linked = await buildLinkedAccount(admin);
    const error = vi.spyOn(Logger, "error").mockImplementation(() => {});
    // A wrong client secret is refused with a different error code.
    vi.spyOn(GitLab, "refreshToken").mockRejectedValue(
      new OAuthTokenError("GitLab", "invalid_client")
    );
    vi.spyOn(GitLab, "getIssue").mockRejectedValue(requestError(401));

    expect(await GitLab.unfurl(issueUrl, admin)).toHaveProperty("error");
    expect(await Integration.findByPk(linked.id)).not.toBe(null);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("client id and secret"),
      expect.any(OAuthTokenError)
    );
  });

  it("should not pass other URLs on the instance to later providers", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    await buildLinkedAccount(admin);

    expect(
      await GitLab.unfurl(`${gitlabUrl}/secret/p/-/commit/abc123`, admin)
    ).toHaveProperty("error");
    expect(
      await GitLab.unfurl("https://example.com/secret/p", admin)
    ).toBeUndefined();
  });

  it("should not pass URLs of the GITLAB_URL instance to later providers without a workspace integration", async () => {
    const original = env.GITLAB_URL;
    env.GITLAB_URL = gitlabUrl;
    try {
      const user = await buildUser();
      expect(await GitLab.unfurl(issueUrl, user)).toHaveProperty("error");
    } finally {
      env.GITLAB_URL = original;
    }
  });
});

// Requests to GitLab's OAuth endpoint are answered by msw, which the test
// setup registers for every server test and resets between tests.
describe("GitLab token requests", () => {
  it("should refresh a token with the given application", async () => {
    let params: URLSearchParams | undefined;
    msw.use(
      http.post(tokenUrl, ({ request }) => {
        params = new URL(request.url).searchParams;
        return HttpResponse.json(refreshed);
      })
    );

    expect(
      await GitLab.refreshToken({
        refreshToken: "refresh",
        customUrl: gitlabUrl,
        clientId: "client-a",
        clientSecret: "client-a-secret",
      })
    ).toEqual(refreshed);
    expect(params?.get("grant_type")).toEqual("refresh_token");
    expect(params?.get("refresh_token")).toEqual("refresh");
    expect(params?.get("client_id")).toEqual("client-a");
    expect(params?.get("client_secret")).toEqual("client-a-secret");
  });

  it("should carry the OAuth error code of a refused refresh", async () => {
    msw.use(
      http.post(tokenUrl, () =>
        HttpResponse.json(
          {
            error: "invalid_grant",
            error_description:
              "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.",
          },
          { status: 400 }
        )
      )
    );

    const promise = GitLab.refreshToken({
      refreshToken: "refresh",
      customUrl: gitlabUrl,
    });
    await expect(promise).rejects.toBeInstanceOf(OAuthTokenError);
    await expect(promise).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("should fail on a refusal that is not an OAuth error", async () => {
    msw.use(
      http.post(
        tokenUrl,
        () => new HttpResponse("Bad Gateway", { status: 502 })
      )
    );

    await expect(
      GitLab.refreshToken({ refreshToken: "refresh", customUrl: gitlabUrl })
    ).rejects.toThrow("status: 502, Bad Gateway");
  });

  it("should fail with the body when a successful response is not JSON", async () => {
    // The page of a proxy in front of the instance that answers with status
    // 200.
    msw.use(
      http.post(
        tokenUrl,
        () => new HttpResponse("<html>Sign in</html>", { status: 200 })
      )
    );

    await expect(
      GitLab.refreshToken({ refreshToken: "refresh", customUrl: gitlabUrl })
    ).rejects.toThrow("status: 200, <html>Sign in</html>");
  });
});

describe("#urls.unfurl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should not pass URLs of the GITLAB_URL instance to Iframely without a workspace integration", async () => {
    const original = env.GITLAB_URL;
    env.GITLAB_URL = gitlabUrl;
    try {
      const user = await buildUser();
      const iframely = vi.spyOn(Iframely, "requestResource");

      const res = await server.post("/api/urls.unfurl", user, {
        body: { url: issueUrl },
      });
      expect(res.status).toEqual(204);
      expect(iframely).not.toHaveBeenCalled();
    } finally {
      env.GITLAB_URL = original;
    }
  });

  it("should not return content to a user without a linked account", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });
    vi.spyOn(GitLab, "getIssue").mockResolvedValue(issue);
    const iframely = vi.spyOn(Iframely, "requestResource");

    const res = await server.post("/api/urls.unfurl", user, {
      body: { url: issueUrl },
    });
    expect(res.status).toEqual(204);
    expect(iframely).not.toHaveBeenCalled();
  });

  it("should not pass URLs of an instance being connected to Iframely", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    await integration.update({
      settings: { gitlab: { url: gitlabUrl, pending: true } },
    });
    const iframely = vi.spyOn(Iframely, "requestResource");

    const res = await server.post("/api/urls.unfurl", admin, {
      body: { url: issueUrl },
    });
    expect(res.status).toEqual(204);
    expect(iframely).not.toHaveBeenCalled();
  });

  it("should not leak a cached unfurl to another user", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin);
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });
    await buildLinkedAccount(userA);
    vi.spyOn(GitLab, "getIssue").mockResolvedValue(issue);

    const resA = await server.post("/api/urls.unfurl", userA, {
      body: { url: issueUrl },
    });
    expect(resA.status).toEqual(200);
    expect((await resA.json()).title).toEqual("Secret issue");

    const resB = await server.post("/api/urls.unfurl", userB, {
      body: { url: issueUrl },
    });
    expect(resB.status).toEqual(204);
  });
});

describe("GitLabIssueProvider", () => {
  it("should remove the accounts linked to a deleted GitLab user", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    // A legacy connection stored the admin's account on the integration.
    await integration.update({
      settings: {
        gitlab: {
          url: gitlabUrl,
          installation: { id: 1, account: { id: 1, name: "a", avatarUrl: "" } },
        },
      },
    });
    const user = await buildUser({ teamId: admin.teamId });
    const linked = await buildLinkedAccount(user);
    // The same account id on another instance belongs to someone else.
    const other = await buildUser({ teamId: admin.teamId });
    const otherLinked = await buildLinkedAccount(other);
    await otherLinked.update({
      settings: { gitlab: { account: { id: 1, name: "b", avatarUrl: "" } } },
    });

    await new GitLabIssueProvider().handleWebhook({
      payload: { event_name: "user_destroy", user_id: 1 },
      headers: { "x-gitlab-instance": gitlabUrl },
    });

    expect(await Integration.findByPk(linked.id, { paranoid: false })).toBe(
      null
    );
    expect(
      await IntegrationAuthentication.findByPk(linked.authenticationId)
    ).toBe(null);
    expect(await Integration.findByPk(otherLinked.id)).not.toBe(null);
    expect(await Integration.findByPk(integration.id)).not.toBe(null);
  });

  it("should never list sources with a token left by a legacy connection", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const createClient = vi.spyOn(
      GitLab as unknown as { createClient: () => unknown },
      "createClient"
    );

    expect(
      await new GitLabIssueProvider().fetchSources(
        integration as Integration<IntegrationType.Embed>
      )
    ).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("uninstall", () => {
  it("should remove the accounts linked through the integration", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });
    const linked = await buildLinkedAccount(user);

    await uninstall(integration);

    expect(await Integration.findByPk(linked.id, { paranoid: false })).toBe(
      null
    );
    expect(
      await IntegrationAuthentication.findByPk(linked.authenticationId)
    ).toBe(null);
  });

  it("should keep linked accounts while the instance is still connected", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    // Connected again, for example before the removal was processed.
    const other = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });
    const linked = await buildLinkedAccount(user, {
      integrationId: integration.id,
    });

    await integration.destroy();
    await uninstall(integration);

    // The same application issued the token, so the account is moved over.
    const kept = (await Integration.findByPk(linked.id, {
      rejectOnEmpty: true,
    })) as Integration<IntegrationType.LinkedAccount>;
    expect(kept.settings.gitlab?.integrationId).toEqual(other.id);
  });

  it("should keep accounts without a recorded integration when an integration being connected is removed", async () => {
    const admin = await buildAdmin();
    await buildWorkspaceIntegration(admin, "client-a");
    // Connected again with another OAuth application, but never completed.
    const pending = await buildWorkspaceIntegration(admin, "client-p");
    await pending.update({
      settings: { gitlab: { url: gitlabUrl, pending: true } },
    });
    const user = await buildUser({ teamId: admin.teamId });
    // Linked before the integration was recorded with the account.
    const linked = await buildLinkedAccount(user);

    await pending.destroy();
    await uninstall(pending);

    expect(await Integration.findByPk(linked.id)).not.toBe(null);
  });

  it("should treat accounts without a recorded integration as linked through the oldest", async () => {
    const admin = await buildAdmin();
    const oldest = await buildWorkspaceIntegration(admin, "client-a");
    const newer = await buildWorkspaceIntegration(admin, "client-b");
    await setCreatedAt(oldest, new Date("2020-01-01"));
    await setCreatedAt(newer, new Date("2020-01-02"));
    const user = await buildUser({ teamId: admin.teamId });
    const linked = await buildLinkedAccount(user);

    // The token is refreshed through the oldest, so it is not affected.
    await newer.destroy();
    await uninstall(newer);
    expect(await Integration.findByPk(linked.id)).not.toBe(null);

    await buildWorkspaceIntegration(admin, "client-b");
    await oldest.destroy();
    await uninstall(oldest);
    expect(await Integration.findByPk(linked.id, { paranoid: false })).toBe(
      null
    );
  });

  it("should remove accounts whose OAuth application is no longer connected", async () => {
    const admin = await buildAdmin();
    // A previous version could configure the same instance several times.
    const integration = await buildWorkspaceIntegration(admin, "client-a");
    const other = await buildWorkspaceIntegration(admin, "client-b");
    const user = await buildUser({ teamId: admin.teamId });
    const otherUser = await buildUser({ teamId: admin.teamId });
    const linked = await buildLinkedAccount(user, {
      integrationId: integration.id,
    });
    const otherLinked = await buildLinkedAccount(otherUser, {
      integrationId: other.id,
    });

    await integration.destroy();
    await uninstall(integration);

    expect(await Integration.findByPk(linked.id, { paranoid: false })).toBe(
      null
    );
    expect(
      await IntegrationAuthentication.findByPk(linked.authenticationId)
    ).toBe(null);
    expect(await Integration.findByPk(otherLinked.id)).not.toBe(null);
  });
});
