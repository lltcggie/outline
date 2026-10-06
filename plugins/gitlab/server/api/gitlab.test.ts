// @vitest-isolate true
import dns from "node:dns";
import { IntegrationService, IntegrationType } from "@shared/types";
import { Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import {
  buildAdmin,
  buildTeam,
  buildUser,
  buildViewer,
} from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { GitLabOAuthNonceCookie } from "../../shared/GitLabUtils";
import { GitLab } from "../gitlab";

// The self-managed instance used in tests does not resolve, so DNS lookups
// performed by the SSRF protection return a public address.
vi.spyOn(dns.promises, "lookup").mockImplementation((async () => [
  { address: "93.184.216.34", family: 4 },
]) as unknown as typeof dns.promises.lookup);

const server = getTestServer();
const gitlabUrl = "https://gitlab.example.com";

/**
 * Creates a workspace integration for a self-managed instance.
 *
 * @param user the admin that connects the instance.
 * @param options.pending whether the instance is still being connected.
 * @param options.clientId the client id of the OAuth application.
 * @param options.url the instance URL as stored.
 * @returns the workspace integration.
 */
async function buildWorkspaceIntegration(
  user: User,
  {
    pending,
    clientId = "client-id",
    url = gitlabUrl,
  }: { pending?: boolean; clientId?: string; url?: string } = {}
) {
  const authentication = await IntegrationAuthentication.create({
    service: IntegrationService.GitLab,
    userId: user.id,
    teamId: user.teamId,
    clientId,
    clientSecret: "client-secret",
  });
  return Integration.create({
    service: IntegrationService.GitLab,
    type: IntegrationType.Embed,
    userId: user.id,
    teamId: user.teamId,
    authenticationId: authentication.id,
    settings: { gitlab: { url, ...(pending ? { pending } : {}) } },
  });
}

/**
 * Completes the OAuth callback for a user with a mocked GitLab account.
 *
 * @param user the user completing the callback.
 * @param integrationId the workspace integration in the state.
 * @param gitlabUserId the id of the GitLab account returned by GitLab.
 * @returns the response.
 */
async function callback(
  user: User,
  integrationId: string,
  gitlabUserId: number
) {
  vi.spyOn(GitLab, "oauthAccess").mockResolvedValue({
    access_token: `token-${user.id}`,
    token_type: "bearer",
    expires_in: 7200,
    refresh_token: `refresh-${user.id}`,
    scope: "read_api read_user",
    created_at: Date.now(),
  });
  vi.spyOn(GitLab, "getCurrentUser").mockResolvedValue({
    id: gitlabUserId,
    username: `gitlab-${gitlabUserId}`,
    avatar_url: "https://gitlab.example.com/avatar.png",
    url: gitlabUrl,
  } as Awaited<ReturnType<typeof GitLab.getCurrentUser>>);

  const state = JSON.stringify({
    teamId: user.teamId,
    nonce: "nonce",
    integrationId,
  });
  return server.get(
    `/api/gitlab.callback?state=${encodeURIComponent(state)}&code=123`,
    user,
    {
      redirect: "manual",
      headers: { Cookie: `${GitLabOAuthNonceCookie}=nonce` },
    }
  );
}

/**
 * Finds the GitLab accounts linked by a user.
 *
 * @param user the user to find linked accounts for.
 * @returns the linked account integrations.
 */
function findLinkedAccounts(user: User) {
  return Integration.findAll({
    where: {
      service: IntegrationService.GitLab,
      type: IntegrationType.LinkedAccount,
      userId: user.id,
    },
    include: [{ model: IntegrationAuthentication, as: "authentication" }],
  }) as Promise<Integration<IntegrationType.LinkedAccount>[]>;
}

describe("#gitlab.connect", () => {
  it("should require an admin", async () => {
    const user = await buildUser();
    const res = await server.post("/api/gitlab.connect", user, {
      body: { url: gitlabUrl, clientId: "id", clientSecret: "secret" },
    });
    expect(res.status).toEqual(403);
  });

  it("should store the OAuth application without a token", async () => {
    const admin = await buildAdmin();
    const res = await server.post("/api/gitlab.connect", admin, {
      body: { url: gitlabUrl, clientId: "id", clientSecret: "secret" },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);

    const integration = (await Integration.findOne({
      where: { teamId: admin.teamId, service: IntegrationService.GitLab },
      include: [{ model: IntegrationAuthentication, as: "authentication" }],
    })) as Integration<IntegrationType.Embed>;
    expect(integration.type).toEqual(IntegrationType.Embed);
    expect(integration.settings.gitlab?.url).toEqual(gitlabUrl);
    expect(integration.authentication.clientId).toEqual("id");
    expect(integration.authentication.token).toBeFalsy();
    // Not used until the admin has completed authorization.
    expect(integration.settings.gitlab?.pending).toBe(true);
    expect(GitLab.isConnected(integration)).toBe(false);

    const redirectUrl = new URL(body.data.redirectUrl);
    expect(redirectUrl.origin).toEqual(gitlabUrl);
    expect(
      JSON.parse(redirectUrl.searchParams.get("state")!).integrationId
    ).toEqual(integration.id);
  });

  it("should drop a token stored by a legacy connection", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const authentication = await IntegrationAuthentication.findByPk(
      integration.authenticationId,
      { rejectOnEmpty: true }
    );
    await authentication.update({ token: "legacy-token" });

    const res = await server.post("/api/gitlab.connect", admin, {
      body: { url: gitlabUrl, clientId: "new-id", clientSecret: "secret" },
    });
    expect(res.status).toEqual(200);

    await authentication.reload();
    expect(authentication.clientId).toEqual("new-id");
    expect(authentication.token).toBeFalsy();
    expect(
      await Integration.count({
        where: { teamId: admin.teamId, type: IntegrationType.Embed },
      })
    ).toEqual(1);
  });

  it("should drop the token and account of a legacy GitLab Cloud connection", async () => {
    const admin = await buildAdmin();
    const authentication = await IntegrationAuthentication.create({
      service: IntegrationService.GitLab,
      userId: admin.id,
      teamId: admin.teamId,
      token: "legacy-token",
      refreshToken: "legacy-refresh",
    });
    const integration = await Integration.create({
      service: IntegrationService.GitLab,
      type: IntegrationType.Embed,
      userId: admin.id,
      teamId: admin.teamId,
      authenticationId: authentication.id,
      settings: {
        gitlab: {
          installation: {
            id: 1,
            account: { id: 1, name: "legacy", avatarUrl: "" },
          },
        },
      },
    });

    // GitLab Cloud is connected without credentials of its own.
    const res = await server.post("/api/gitlab.connect", admin, { body: {} });
    expect(res.status).toEqual(200);

    await authentication.reload();
    expect(authentication.token).toBeFalsy();
    expect(authentication.refreshToken).toBeFalsy();
    await integration.reload();
    expect(
      (integration as Integration<IntegrationType.Embed>).settings.gitlab
        ?.installation
    ).toBeUndefined();
    expect(
      await Integration.count({
        where: { teamId: admin.teamId, type: IntegrationType.Embed },
      })
    ).toEqual(1);
  });

  it("should remove linked accounts when the OAuth application changes", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });
    await callback(user, integration.id, 1);

    const res = await server.post("/api/gitlab.connect", admin, {
      body: { url: gitlabUrl, clientId: "new-id", clientSecret: "secret" },
    });
    expect(res.status).toEqual(200);

    expect(await findLinkedAccounts(user)).toHaveLength(0);
    await integration.reload();
    expect(
      (integration as Integration<IntegrationType.Embed>).settings.gitlab
        ?.pending
    ).toBe(true);
  });

  it("should keep accounts linked through another integration when the OAuth application changes", async () => {
    const admin = await buildAdmin();
    // A previous version could configure the same instance several times.
    const integration = await buildWorkspaceIntegration(admin, {
      clientId: "client-a",
    });
    const other = await buildWorkspaceIntegration(admin, {
      clientId: "client-b",
    });
    const user = await buildUser({ teamId: admin.teamId });
    const otherUser = await buildUser({ teamId: admin.teamId });
    await callback(user, integration.id, 1);
    await callback(otherUser, other.id, 2);

    const res = await server.post("/api/gitlab.connect", admin, {
      body: { url: gitlabUrl, clientId: "new-id", clientSecret: "secret" },
    });
    expect(res.status).toEqual(200);

    // Only the accounts linked through the integration that was changed lose
    // the application that issued their tokens.
    await integration.reload();
    const changed = (integration as Integration<IntegrationType.Embed>).settings
      .gitlab?.pending
      ? user
      : otherUser;
    const unchanged = changed === user ? otherUser : user;
    expect(await findLinkedAccounts(changed)).toHaveLength(0);
    expect(await findLinkedAccounts(unchanged)).toHaveLength(1);
  });

  it("should normalize the URL of an instance stored by an earlier version", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin, {
      url: "https://GitLab.Example.com/",
    });

    const res = await server.post("/api/gitlab.connect", admin, {
      body: { url: gitlabUrl, clientId: "client-id", clientSecret: "secret" },
    });
    expect(res.status).toEqual(200);

    await integration.reload();
    expect(
      (integration as Integration<IntegrationType.Embed>).settings.gitlab?.url
    ).toEqual(gitlabUrl);
    expect(
      await Integration.count({
        where: { teamId: admin.teamId, type: IntegrationType.Embed },
      })
    ).toEqual(1);
  });

  it("should keep linked accounts when the same OAuth application is connected again", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });
    await callback(user, integration.id, 1);

    const res = await server.post("/api/gitlab.connect", admin, {
      body: { url: gitlabUrl, clientId: "client-id", clientSecret: "new" },
    });
    expect(res.status).toEqual(200);

    expect(await findLinkedAccounts(user)).toHaveLength(1);
    await integration.reload();
    expect(
      (integration as Integration<IntegrationType.Embed>).settings.gitlab
        ?.pending
    ).toBeFalsy();
  });
});

describe("#gitlab.authorize", () => {
  it("should allow any member to link their account", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const viewer = await buildViewer({ teamId: admin.teamId });

    const res = await server.post("/api/gitlab.authorize", viewer, {
      body: { integrationId: integration.id },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(new URL(body.data.redirectUrl).searchParams.get("client_id")).toBe(
      "client-id"
    );
  });

  it("should not allow linking through another team's integration", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: (await buildTeam()).id });

    const res = await server.post("/api/gitlab.authorize", user, {
      body: { integrationId: integration.id },
    });
    expect(res.status).toEqual(404);
  });

  it("should only let an admin authorize with a pending integration", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin, {
      pending: true,
    });
    const user = await buildUser({ teamId: admin.teamId });

    const memberRes = await server.post("/api/gitlab.authorize", user, {
      body: { integrationId: integration.id },
    });
    expect(memberRes.status).toEqual(403);

    const adminRes = await server.post("/api/gitlab.authorize", admin, {
      body: { integrationId: integration.id },
    });
    expect(adminRes.status).toEqual(200);
  });
});

describe("#gitlab.callback", () => {
  it("should reject callback when state nonce does not match cookie", async () => {
    const user = await buildUser();
    const state = JSON.stringify({
      teamId: user.teamId,
      nonce: "attacker-nonce",
    });
    const res = await server.get(
      `/api/gitlab.callback?state=${encodeURIComponent(state)}&code=123`,
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
      `/api/gitlab.callback?state=${encodeURIComponent(state)}&code=123`,
      user,
      { redirect: "manual" }
    );
    expect(res.status).toEqual(400);
  });

  it("should fail when state is not valid JSON", async () => {
    const user = await buildUser();
    const res = await server.get(
      `/api/gitlab.callback?state=bad&code=123`,
      user,
      { redirect: "manual" }
    );
    expect(res.status).toEqual(400);
  });

  it("should store the token as the user's own linked account", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });

    const res = await callback(user, integration.id, 1);
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).not.toContain("error");

    const [linked] = await findLinkedAccounts(user);
    expect(linked.settings.gitlab?.url).toEqual(gitlabUrl);
    expect(linked.settings.gitlab?.integrationId).toEqual(integration.id);
    expect(linked.settings.gitlab?.account.id).toEqual(1);
    expect(linked.authentication.token).toEqual(`token-${user.id}`);

    // The workspace integration never receives a token.
    const workspaceAuth = await IntegrationAuthentication.findByPk(
      integration.authenticationId,
      { rejectOnEmpty: true }
    );
    expect(workspaceAuth.token).toBeFalsy();
  });

  it("should update the user's existing linked account", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });

    await callback(user, integration.id, 1);
    await callback(user, integration.id, 2);

    const linked = await findLinkedAccounts(user);
    expect(linked).toHaveLength(1);
    expect(linked[0].settings.gitlab?.account.id).toEqual(2);
  });

  it("should not overwrite another user's linked account", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });

    await callback(userA, integration.id, 1);
    await callback(userB, integration.id, 2);

    const [linkedA] = await findLinkedAccounts(userA);
    const [linkedB] = await findLinkedAccounts(userB);
    expect(linkedA.authentication.token).toEqual(`token-${userA.id}`);
    expect(linkedB.authentication.token).toEqual(`token-${userB.id}`);
  });

  it("should reject a GitLab account already linked by another user", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });

    await callback(userA, integration.id, 1);
    const res = await callback(userB, integration.id, 1);

    expect(res.headers.get("location")).toContain("duplicate_account");
    expect(await findLinkedAccounts(userB)).toHaveLength(0);
  });

  it("should let the admin link the account the workspace was connected with", async () => {
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

    const res = await callback(admin, integration.id, 1);
    expect(res.headers.get("location")).not.toContain("error");
    expect(await findLinkedAccounts(admin)).toHaveLength(1);
  });

  it("should not link through another team's integration", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser();

    const res = await callback(user, integration.id, 1);
    expect(res.headers.get("location")).toContain("error");
    expect(await findLinkedAccounts(user)).toHaveLength(0);
  });

  it("should complete connecting a pending integration when an admin authorizes", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin, {
      pending: true,
    });

    const res = await callback(admin, integration.id, 1);
    expect(res.headers.get("location")).not.toContain("error");
    expect(await findLinkedAccounts(admin)).toHaveLength(1);

    await integration.reload();
    expect(
      (integration as Integration<IntegrationType.Embed>).settings.gitlab
    ).toEqual({ url: gitlabUrl });
  });

  it("should not let a member complete connecting a pending integration", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin, {
      pending: true,
    });
    const user = await buildUser({ teamId: admin.teamId });

    const res = await callback(user, integration.id, 1);
    expect(res.headers.get("location")).toContain("error");
    expect(await findLinkedAccounts(user)).toHaveLength(0);

    await integration.reload();
    expect(
      (integration as Integration<IntegrationType.Embed>).settings.gitlab
        ?.pending
    ).toBe(true);
  });
});

describe("#integrations.list", () => {
  it("should not return other users' GitLab accounts", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });
    await callback(userA, integration.id, 1);

    const res = await server.post("/api/integrations.list", userB, {
      body: { service: IntegrationService.GitLab },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(JSON.stringify(body.data)).not.toContain("gitlab-1");

    const [linkedA] = await findLinkedAccounts(userA);
    const info = await server.post("/api/integrations.info", userB, {
      body: { id: linkedA.id },
    });
    expect(info.status).toEqual(403);
  });
});

describe("#integrations.update", () => {
  it("should not allow an admin to change another user's linked account", async () => {
    const admin = await buildAdmin();
    const integration = await buildWorkspaceIntegration(admin);
    const user = await buildUser({ teamId: admin.teamId });
    await callback(user, integration.id, 1);
    const [linked] = await findLinkedAccounts(user);

    const res = await server.post("/api/integrations.update", admin, {
      body: {
        id: linked.id,
        settings: { gitlab: { url: "https://evil.example.com" } },
      },
    });
    expect(res.status).toEqual(403);

    await linked.reload();
    expect(linked.settings.gitlab?.url).toEqual(gitlabUrl);
  });
});
