// @vitest-isolate true
import { IntegrationService, IntegrationType } from "@shared/types";
import { Event, Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import CacheIssueSourcesTask from "@server/queues/tasks/CacheIssueSourcesTask";
import { buildAdmin, buildUser, buildViewer } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { CacheHelper } from "@server/utils/CacheHelper";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import { GitHubOAuthNonceCookie } from "../../shared/GitHubUtils";
import { GitHub, type UserInstallation } from "../github";
import { SetupAction } from "./schema";

const server = getTestServer();

/**
 * Mocks the exchange of the code and the account GitHub returns for it.
 *
 * @param user the user completing the callback.
 * @param githubUserId the id of the GitHub account returned by GitHub.
 * @param options.expiring whether the app issues expiring tokens.
 * @param options.token the access token GitHub issues.
 */
function mockGitHub(
  user: User,
  githubUserId: number,
  {
    expiring = true,
    token = `token-${user.id}`,
  }: { expiring?: boolean; token?: string } = {}
) {
  vi.spyOn(GitHub, "oauthAccess").mockResolvedValue({
    access_token: token,
    ...(expiring
      ? { expires_in: 28800, refresh_token: `refresh-${user.id}` }
      : {}),
  });
  vi.spyOn(GitHub, "getCurrentUser").mockResolvedValue({
    id: githubUserId,
    login: `github-${githubUserId}`,
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
  });
}

/**
 * Completes the OAuth callback that links a user's own account.
 *
 * @param user the user completing the callback.
 * @param githubUserId the id of the GitHub account returned by GitHub.
 * @param options.expiring whether the app issues expiring tokens.
 * @param options.token the access token GitHub issues.
 * @returns the response.
 */
async function callback(
  user: User,
  githubUserId: number,
  options: { expiring?: boolean; token?: string } = {}
) {
  mockGitHub(user, githubUserId, options);

  const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
  return server.get(
    `/api/github.callback?state=${encodeURIComponent(state)}&code=123`,
    user,
    {
      redirect: "manual",
      headers: { Cookie: `${GitHubOAuthNonceCookie}=nonce` },
    }
  );
}

/**
 * Completes the callback of installing the app, which an admin does.
 *
 * @param user the user completing the callback.
 * @param githubUserId the id of the GitHub account returned by GitHub.
 * @param installationId the installation GitHub redirected with.
 * @param options.accessibleInstallationIds the installations the account can
 * access, only the given one by default.
 * @param options.login the login of the organization the app is installed on.
 * @param options.permissions the permissions of the installation.
 * @returns the response.
 */
async function installCallback(
  user: User,
  githubUserId: number,
  installationId: number,
  {
    accessibleInstallationIds = [installationId],
    login,
    permissions = { issues: "read", pull_requests: "read" },
  }: {
    accessibleInstallationIds?: number[];
    login?: string;
    permissions?: Record<string, string>;
  } = {}
) {
  mockGitHub(user, githubUserId);
  vi.spyOn(GitHub, "getUserInstallations").mockResolvedValue(
    accessibleInstallationIds.map(
      (id) =>
        ({
          id,
          target_id: 100 + id,
          account: {
            id: 100 + id,
            login: login ?? `org-${id}`,
            avatar_url: "https://avatars.githubusercontent.com/u/100",
          },
          permissions,
        }) as unknown as UserInstallation
    )
  );

  const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
  return server.get(
    `/api/github.callback?state=${encodeURIComponent(state)}&code=123&setup_action=${SetupAction.install}&installation_id=${installationId}`,
    user,
    {
      redirect: "manual",
      headers: { Cookie: `${GitHubOAuthNonceCookie}=nonce` },
    }
  );
}

/**
 * Finds the GitHub accounts linked by a user, however many there are.
 *
 * @param user the user to find linked accounts for.
 * @returns the linked account integrations with their authentication.
 */
function findLinkedAccounts(user: User) {
  return GitHub.findLinkedAccounts({ teamId: user.teamId, userId: user.id });
}

/**
 * Finds the workspace integrations recording installations in a team.
 *
 * @param teamId the team to search.
 * @returns the workspace integrations.
 */
function findInstallations(teamId: string) {
  return Integration.findAll<Integration<IntegrationType.Embed>>({
    where: {
      service: IntegrationService.GitHub,
      type: IntegrationType.Embed,
      teamId,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#github.callback", () => {
  it("should reject callback when state nonce does not match cookie", async () => {
    const user = await buildUser();
    const state = JSON.stringify({
      teamId: user.teamId,
      nonce: "attacker-nonce",
    });
    const res = await server.get(
      `/api/github.callback?state=${encodeURIComponent(
        state
      )}&code=123&setup_action=${SetupAction.install}&installation_id=1`,
      user,
      { redirect: "manual" }
    );
    const body = await res.json();
    expect(res.status).toEqual(400);
    expect(body.error).toEqual("state_mismatch");
  });

  it("should reject callback when nonce is missing from state", async () => {
    const user = await buildUser();
    const state = JSON.stringify({ teamId: user.teamId });
    const res = await server.get(
      `/api/github.callback?state=${encodeURIComponent(state)}&code=123`,
      user,
      { redirect: "manual" }
    );
    expect(res.status).toEqual(400);
  });

  it("should fail when state is not valid JSON", async () => {
    const user = await buildUser();
    const res = await server.get(
      `/api/github.callback?state=bad&code=123`,
      user,
      { redirect: "manual" }
    );
    expect(res.status).toEqual(400);
  });

  it("should redirect with the error returned by GitHub", async () => {
    const user = await buildUser();
    const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
    const res = await server.get(
      `/api/github.callback?state=${encodeURIComponent(state)}&error=access_denied`,
      user,
      { redirect: "manual" }
    );
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).toContain("error=access_denied");
  });

  it("should store the token as the user's own linked account", async () => {
    const viewer = await buildViewer();

    const res = await callback(viewer, 1);
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).not.toContain("error");

    const [linked] = await findLinkedAccounts(viewer);
    expect(linked.settings.github?.account).toEqual({
      id: 1,
      name: "github-1",
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    });
    expect(linked.authentication.token).toEqual(`token-${viewer.id}`);
    expect(linked.authentication.refreshToken).toEqual(`refresh-${viewer.id}`);
    expect(linked.authentication.expiresAt).toBeTruthy();
    // No installation is recorded when linking an account.
    expect(await findInstallations(viewer.teamId)).toHaveLength(0);
  });

  it("should link an account of an app that does not expire tokens", async () => {
    const user = await buildUser();

    const res = await callback(user, 1, { expiring: false });
    expect(res.headers.get("location")).not.toContain("error");

    const [linked] = await findLinkedAccounts(user);
    expect(linked.authentication.token).toEqual(`token-${user.id}`);
    expect(linked.authentication.refreshToken).toBeFalsy();
    expect(linked.authentication.expiresAt).toBeFalsy();
  });

  it("should drop the refresh token and expiry when linking again without them", async () => {
    const user = await buildUser();
    vi.spyOn(GitHub, "revokeToken").mockResolvedValue(undefined);

    await callback(user, 1);
    // The app was changed to no longer expire tokens meanwhile.
    await callback(user, 1, { expiring: false, token: "unexpiring-token" });

    const [linked] = await findLinkedAccounts(user);
    expect(linked.authentication.token).toEqual("unexpiring-token");
    expect(linked.authentication.refreshToken).toBeFalsy();
    expect(linked.authentication.expiresAt).toBeFalsy();
  });

  it("should update the user's existing linked account", async () => {
    const user = await buildUser();

    await callback(user, 1);
    await callback(user, 2);

    const linked = await findLinkedAccounts(user);
    expect(linked).toHaveLength(1);
    expect(linked[0].settings.github?.account.id).toEqual(2);
  });

  it("should not overwrite another user's linked account", async () => {
    const admin = await buildAdmin();
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });

    await callback(userA, 1);
    await callback(userB, 2);

    const [linkedA] = await findLinkedAccounts(userA);
    const [linkedB] = await findLinkedAccounts(userB);
    expect(linkedA.authentication.token).toEqual(`token-${userA.id}`);
    expect(linkedB.authentication.token).toEqual(`token-${userB.id}`);
  });

  it("should revoke the token replaced by linking again", async () => {
    const user = await buildUser();
    const revokeToken = vi
      .spyOn(GitHub, "revokeToken")
      .mockResolvedValue(undefined);

    await callback(user, 1, { token: "first-token" });
    expect(revokeToken).not.toHaveBeenCalled();

    await callback(user, 1, { token: "second-token" });
    expect(revokeToken).toHaveBeenCalledWith("first-token");

    const [linked] = await findLinkedAccounts(user);
    expect(linked.authentication.token).toEqual("second-token");
  });

  it("should reject a GitHub account already linked by another user", async () => {
    const admin = await buildAdmin();
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });
    const revokeToken = vi
      .spyOn(GitHub, "revokeToken")
      .mockResolvedValue(undefined);

    await callback(userA, 1);
    const res = await callback(userB, 1, { token: "refused-token" });

    expect(res.headers.get("location")).toContain("duplicate_account");
    expect(await findLinkedAccounts(userB)).toHaveLength(0);
    // The token issued for the refused account is not kept, so GitHub must
    // not keep it valid either.
    expect(revokeToken).toHaveBeenCalledTimes(1);
    expect(revokeToken).toHaveBeenCalledWith("refused-token");
  });

  it("should let the same GitHub account be linked in another workspace", async () => {
    const userA = await buildUser();
    const userB = await buildUser();

    await callback(userA, 1);
    const res = await callback(userB, 1);

    expect(res.headers.get("location")).not.toContain("error");
    expect(await findLinkedAccounts(userB)).toHaveLength(1);
  });

  it("should record the installation and link the admin's account", async () => {
    const admin = await buildAdmin();

    const res = await installCallback(admin, 1, 1);
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).not.toContain("error");

    const [installation] = await findInstallations(admin.teamId);
    expect(installation.settings.github?.installation).toEqual({
      id: 1,
      account: {
        id: 101,
        name: "org-1",
        avatarUrl: "https://avatars.githubusercontent.com/u/100",
      },
    });
    // The workspace integration never receives a token.
    const workspaceAuth = await IntegrationAuthentication.findByPk(
      installation.authenticationId,
      { rejectOnEmpty: true }
    );
    expect(workspaceAuth.token).toBeFalsy();
    expect(workspaceAuth.scopes).toEqual(["issues:read", "pull_requests:read"]);

    const [linked] = await findLinkedAccounts(admin);
    expect(linked.settings.github?.account.id).toEqual(1);
    expect(linked.authentication.token).toEqual(`token-${admin.id}`);
  });

  it("should update the recorded installation rather than record it twice", async () => {
    const admin = await buildAdmin();
    const member = await buildUser({ teamId: admin.teamId });
    const cacheKey = RedisPrefixHelper.getUnfurlKey(
      admin.teamId,
      member.id,
      "https://github.com/org-1/repo/issues/1"
    );

    await installCallback(admin, 1, 1);
    // Cached while the app could not reach the repository yet.
    await CacheHelper.setData(cacheKey, { error: true }, 60);
    // The organization was renamed in GitHub meanwhile.
    await installCallback(admin, 1, 1, { login: "org-renamed" });

    const installations = await findInstallations(admin.teamId);
    expect(installations).toHaveLength(1);
    expect(installations[0].settings.github?.installation.account.name).toEqual(
      "org-renamed"
    );
    expect(await findLinkedAccounts(admin)).toHaveLength(1);
    // The repositories the app can reach may have changed, so the cached
    // unfurls of every member are cleared again.
    expect(await CacheHelper.getData(cacheKey)).toBeUndefined();
  });

  it("should bring the recorded installation up to date when it is recorded again", async () => {
    const admin = await buildAdmin();
    const schedule = vi.spyOn(CacheIssueSourcesTask.prototype, "schedule");

    await installCallback(admin, 1, 1);
    const [installation] = await findInstallations(admin.teamId);
    // Scheduled by the event of the new integration, which is processed
    // elsewhere.
    expect(schedule).not.toHaveBeenCalled();

    // The admin accepted new permissions and added repositories in GitHub,
    // without the webhooks reaching the server.
    await installCallback(admin, 1, 1, {
      permissions: { issues: "read", pull_requests: "read", contents: "read" },
    });

    const workspaceAuth = await IntegrationAuthentication.findByPk(
      installation.authenticationId,
      { rejectOnEmpty: true }
    );
    expect(workspaceAuth.scopes).toEqual([
      "issues:read",
      "pull_requests:read",
      "contents:read",
    ]);
    expect(schedule).toHaveBeenCalledExactlyOnceWith({
      integrationId: installation.id,
    });
  });

  it("should not record an installation the admin cannot access", async () => {
    const admin = await buildAdmin();
    const revokeToken = vi
      .spyOn(GitHub, "revokeToken")
      .mockResolvedValue(undefined);

    const res = await installCallback(admin, 1, 1, {
      accessibleInstallationIds: [2],
    });
    expect(res.headers.get("location")).toContain("error");

    expect(await findInstallations(admin.teamId)).toHaveLength(0);
    expect(await findLinkedAccounts(admin)).toHaveLength(0);
    // The token issued for the admin is not kept, so GitHub must not keep it
    // valid either.
    expect(revokeToken).toHaveBeenCalledExactlyOnceWith(`token-${admin.id}`);
  });

  it("should record the installation although the admin's account is linked by another user", async () => {
    const admin = await buildAdmin();
    const user = await buildUser({ teamId: admin.teamId });
    await callback(user, 1);

    const res = await installCallback(admin, 1, 1);
    expect(res.headers.get("location")).toContain("duplicate_account");

    // The app is installed in GitHub either way, only the account is not
    // linked.
    expect(await findInstallations(admin.teamId)).toHaveLength(1);
    expect(await findLinkedAccounts(admin)).toHaveLength(0);
    expect(await findLinkedAccounts(user)).toHaveLength(1);
  });

  it("should not let a member record an installation", async () => {
    const user = await buildUser();

    const res = await installCallback(user, 1, 1);
    expect(res.headers.get("location")).toContain("error=install_forbidden");

    expect(await findInstallations(user.teamId)).toHaveLength(0);
    expect(await findLinkedAccounts(user)).toHaveLength(0);
  });

  it("should redirect with an error when GitHub rejects the code", async () => {
    const user = await buildUser();
    vi.spyOn(GitHub, "oauthAccess").mockRejectedValue(new Error("rejected"));
    const revokeToken = vi.spyOn(GitHub, "revokeToken");

    const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
    const res = await server.get(
      `/api/github.callback?state=${encodeURIComponent(state)}&code=123`,
      user,
      {
        redirect: "manual",
        headers: { Cookie: `${GitHubOAuthNonceCookie}=nonce` },
      }
    );
    expect(res.headers.get("location")).toContain("error=unauthenticated");
    expect(await findLinkedAccounts(user)).toHaveLength(0);
    // No token was issued, so there is nothing to revoke.
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it("should not keep a token when linking fails part way through", async () => {
    const user = await buildUser();
    vi.spyOn(Integration, "createWithCtx").mockRejectedValue(
      new Error("database unavailable")
    );
    const revokeToken = vi
      .spyOn(GitHub, "revokeToken")
      .mockResolvedValue(undefined);

    const res = await callback(user, 1);

    expect(res.headers.get("location")).toContain("error=unauthenticated");
    expect(await findLinkedAccounts(user)).toHaveLength(0);
    // The authentication created before the failure is rolled back.
    expect(
      await IntegrationAuthentication.count({
        where: { service: IntegrationService.GitHub, userId: user.id },
      })
    ).toEqual(0);
    // The token issued for the link is not kept, so GitHub must not keep it
    // valid either.
    expect(revokeToken).toHaveBeenCalledExactlyOnceWith(`token-${user.id}`);
  });

  it("should keep the token when only a hook after the commit fails", async () => {
    const user = await buildUser();
    // The event of the new account is scheduled once the link is committed.
    vi.spyOn(Event, "schedule").mockRejectedValue(
      new Error("queue unavailable")
    );
    const revokeToken = vi
      .spyOn(GitHub, "revokeToken")
      .mockResolvedValue(undefined);

    const res = await callback(user, 1);

    // The link is complete, only its event was lost.
    expect(res.headers.get("location")).not.toContain("error");
    const [linked] = await findLinkedAccounts(user);
    expect(linked.authentication.token).toEqual(`token-${user.id}`);
    expect(revokeToken).not.toHaveBeenCalled();
  });
});

describe("#integrations", () => {
  it("should not return other users' GitHub accounts", async () => {
    const admin = await buildAdmin();
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });
    await callback(userA, 1);

    const res = await server.post("/api/integrations.list", userB, {
      body: { service: IntegrationService.GitHub },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(JSON.stringify(body.data)).not.toContain("github-1");

    const [linkedA] = await findLinkedAccounts(userA);
    const info = await server.post("/api/integrations.info", userB, {
      body: { id: linkedA.id },
    });
    expect(info.status).toEqual(403);

    const own = await server.post("/api/integrations.list", userA, {
      body: { service: IntegrationService.GitHub },
    });
    const ownBody = await own.json();
    expect(ownBody.data).toHaveLength(1);
    expect(ownBody.data[0].settings.github.account.name).toEqual("github-1");
  });

  it("should return installations to every member", async () => {
    const admin = await buildAdmin();
    const user = await buildUser({ teamId: admin.teamId });
    await installCallback(admin, 1, 1);

    const res = await server.post("/api/integrations.list", user, {
      body: { service: IntegrationService.GitHub },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toEqual(IntegrationType.Embed);
    expect(body.data[0].settings.github.installation.account.name).toEqual(
      "org-1"
    );
  });
});
