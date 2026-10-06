// @vitest-isolate true
import { IntegrationService, IntegrationType } from "@shared/types";
import { Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import { buildAdmin, buildUser } from "@server/test/factories";
import { sequelize } from "@server/storage/database";
import { getTestServer } from "@server/test/support";
import Iframely from "plugins/iframely/server/iframely";
import { GitLabIssueProvider } from "./GitLabIssueProvider";
import env from "./env";
import { GitLab } from "./gitlab";
import { uninstall } from "./uninstall";

const server = getTestServer();
const gitlabUrl = "https://gitlab.example.com";
const issueUrl = `${gitlabUrl}/secret/p/-/issues/1`;

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
    ...(options.expired
      ? { refreshToken: "refresh-token", expiresAt: new Date(0) }
      : {}),
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
        .spyOn(
          GitLab as unknown as {
            refreshToken: (params: {
              clientId?: string;
              clientSecret?: string;
            }) => Promise<unknown>;
          },
          "refreshToken"
        )
        .mockResolvedValue({
          access_token: "refreshed-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      const getIssue = vi.spyOn(GitLab, "getIssue").mockResolvedValue(issue);

      await GitLab.unfurl(issueUrl, admin);

      const clientId = index === 0 ? "client-a" : "client-b";
      expect(refreshToken).toHaveBeenCalledWith(
        expect.objectContaining({
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
    await buildLinkedAccount(admin);
    vi.spyOn(GitLab, "getIssue").mockRejectedValue(new Error("404 Not Found"));

    expect(await GitLab.unfurl(issueUrl, admin)).toHaveProperty("error");
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
      teamId: admin.teamId,
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
