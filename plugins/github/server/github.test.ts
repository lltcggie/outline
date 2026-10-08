// @vitest-isolate true
import { http, HttpResponse } from "msw";
import { RequestError } from "octokit";
import {
  IntegrationService,
  IntegrationType,
  UnfurlResourceType,
} from "@shared/types";
import Logger from "@server/logging/Logger";
import { Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import { buildAdmin, buildUser } from "@server/test/factories";
import { server as msw } from "@server/test/msw";
import { getTestServer } from "@server/test/support";
import { OAuthTokenError } from "@server/utils/OAuthTokenError";
import Iframely from "plugins/iframely/server/iframely";
import { GitHubIssueProvider } from "./GitHubIssueProvider";
import env from "./env";
import { GitHub } from "./github";
import { uninstall } from "./uninstall";

const server = getTestServer();

afterEach(() => {
  vi.restoreAllMocks();
});
const issueUrl = "https://github.com/secret/repo/issues/1";
const pullUrl = "https://github.com/secret/repo/pull/2";
const projectUrl = "https://github.com/orgs/secret/projects/3";

const issue = {
  number: 1,
  title: "Secret issue",
  body_text: "Secret body",
  html_url: issueUrl,
  state: "open",
  labels: [{ name: "bug", color: "ff0000" }],
  user: { login: "a", avatar_url: "" },
  created_at: new Date().toISOString(),
} as unknown as Awaited<ReturnType<typeof GitHub.getIssue>>;

const pull = {
  number: 2,
  title: "Secret pull request",
  body: "Secret body",
  html_url: pullUrl,
  state: "open",
  draft: true,
  merged: false,
  user: { login: "a", avatar_url: "" },
  created_at: new Date().toISOString(),
} as unknown as Awaited<ReturnType<typeof GitHub.getPullRequest>>;

/**
 * Creates an error as GitHub's client reports a refused request.
 *
 * @param status the status GitHub responded with.
 * @param headers the headers of the response, none when omitted.
 * @returns the error.
 */
function requestError(status: number, headers?: Record<string, string>) {
  const request: RequestError["request"] = {
    method: "GET",
    url: "https://api.github.com/x",
    headers: {},
  };
  return new RequestError(`GitHub responded with ${status}`, status, {
    request,
    ...(headers
      ? { response: { headers, status, url: request.url, data: {} } }
      : {}),
  });
}

/**
 * Records an installation of the app for a team.
 *
 * @param admin the admin that installed the app.
 * @param installationId the id of the installation.
 * @returns the workspace integration.
 */
async function buildInstallation(admin: User, installationId = 1) {
  const authentication = await IntegrationAuthentication.create({
    service: IntegrationService.GitHub,
    userId: admin.id,
    teamId: admin.teamId,
    scopes: ["issues:read"],
  });
  return Integration.create<Integration<IntegrationType.Embed>>({
    service: IntegrationService.GitHub,
    type: IntegrationType.Embed,
    userId: admin.id,
    teamId: admin.teamId,
    authenticationId: authentication.id,
    settings: {
      github: {
        installation: {
          id: installationId,
          account: { id: 1, name: "org", avatarUrl: "" },
        },
      },
    },
  });
}

/**
 * Links a GitHub account for a user.
 *
 * @param user the user linking the account.
 * @param options.expired whether the token has expired and must be refreshed.
 * @param options.accountId the id of the GitHub account.
 * @returns the linked account integration.
 */
async function buildLinkedAccount(
  user: User,
  {
    expired = false,
    accountId = 1,
  }: { expired?: boolean; accountId?: number } = {}
) {
  const authentication = await IntegrationAuthentication.create({
    service: IntegrationService.GitHub,
    userId: user.id,
    teamId: user.teamId,
    token: `token-${user.id}`,
    refreshToken: `refresh-${user.id}`,
    expiresAt: expired ? new Date(0) : new Date(Date.now() + 3600_000),
  });
  return Integration.create<Integration<IntegrationType.LinkedAccount>>({
    service: IntegrationService.GitHub,
    type: IntegrationType.LinkedAccount,
    userId: user.id,
    teamId: user.teamId,
    authenticationId: authentication.id,
    settings: {
      github: { account: { id: accountId, name: "a", avatarUrl: "" } },
    },
  });
}

describe("GitHub.unfurl", () => {
  it("should ignore URLs that are not on GitHub", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    const getIssue = vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);

    expect(
      await GitHub.unfurl("https://example.com/secret/repo/issues/1", user)
    ).toBeUndefined();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("should ignore URLs when GitHub is not in use", async () => {
    const user = await buildUser();
    const getIssue = vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);

    expect(await GitHub.unfurl(issueUrl, user)).toBeUndefined();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("should not unfurl without a linked account", async () => {
    const admin = await buildAdmin();
    await buildInstallation(admin);
    const user = await buildUser({ teamId: admin.teamId });
    const getIssue = vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);

    // The URL is claimed, so that it is not passed on to later providers.
    expect(await GitHub.unfurl(issueUrl, user)).toHaveProperty("error");
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("should not use another user's linked account", async () => {
    const admin = await buildAdmin();
    await buildInstallation(admin);
    const user = await buildUser({ teamId: admin.teamId });
    const other = await buildUser({ teamId: admin.teamId });
    await buildLinkedAccount(other);
    const getIssue = vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);

    expect(await GitHub.unfurl(issueUrl, user)).toHaveProperty("error");
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("should unfurl an issue with the user's own token", async () => {
    const admin = await buildAdmin();
    await buildInstallation(admin);
    const user = await buildUser({ teamId: admin.teamId });
    const other = await buildUser({ teamId: admin.teamId });
    await buildLinkedAccount(user);
    await buildLinkedAccount(other, { accountId: 2 });
    const getIssue = vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);

    const result = await GitHub.unfurl(issueUrl, user);
    expect(getIssue).toHaveBeenCalledWith(
      `token-${user.id}`,
      expect.objectContaining({ owner: "secret", repo: "repo", id: 1 })
    );
    expect(result).toMatchObject({
      type: UnfurlResourceType.Issue,
      url: issueUrl,
      id: "#1",
      title: "Secret issue",
      description: "Secret body",
      labels: [{ name: "bug", color: "#ff0000" }],
      state: { name: "open" },
    });
  });

  it("should unfurl with a linked account before the app is installed", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(GitHub, "getPullRequest").mockResolvedValue(pull);

    const result = await GitHub.unfurl(pullUrl, user);
    expect(result).toMatchObject({
      type: UnfurlResourceType.PR,
      id: "#2",
      title: "Secret pull request",
      state: { name: "open", draft: true },
    });
  });

  it("should unfurl a project", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user);
    vi.spyOn(GitHub, "getProject").mockResolvedValue({
      number: 3,
      title: "Secret project",
      description: null,
      url: projectUrl,
      createdAt: new Date().toISOString(),
      closed: false,
    });

    const result = await GitHub.unfurl(projectUrl, user);
    expect(result).toMatchObject({
      type: UnfurlResourceType.Project,
      id: "#3",
      name: "Secret project",
      state: { type: "open" },
    });
  });

  it("should refresh an expired token", async () => {
    const user = await buildUser();
    await buildLinkedAccount(user, { expired: true });
    const refreshToken = vi.spyOn(GitHub, "refreshToken").mockResolvedValue({
      access_token: "refreshed-token",
      refresh_token: "next-refresh-token",
      expires_in: 28800,
    });
    const getIssue = vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);

    await GitHub.unfurl(issueUrl, user);

    expect(refreshToken).toHaveBeenCalledWith(`refresh-${user.id}`);
    expect(getIssue).toHaveBeenCalledWith("refreshed-token", expect.anything());
  });

  it("should return an error when GitHub denies access", async () => {
    const user = await buildUser();
    const linked = await buildLinkedAccount(user);
    vi.spyOn(GitHub, "getIssue").mockRejectedValue(requestError(404));
    const refreshToken = vi.spyOn(GitHub, "refreshToken");

    expect(await GitHub.unfurl(issueUrl, user)).toEqual({
      error: "Resource not found",
    });
    // Only a rejected token is recovered from.
    expect(refreshToken).not.toHaveBeenCalled();
    expect(await Integration.findByPk(linked.id)).not.toBe(null);
  });

  it("should report a rate limit rather than hiding the resource", async () => {
    const user = await buildUser();
    const linked = await buildLinkedAccount(user);
    vi.spyOn(GitHub, "getIssue").mockRejectedValue(
      requestError(403, { "x-ratelimit-remaining": "0" })
    );
    const warn = vi.spyOn(Logger, "warn");
    const refreshToken = vi.spyOn(GitHub, "refreshToken");

    expect(await GitHub.unfurl(issueUrl, user)).toEqual({
      error: "GitHub rate limit reached",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("rate limit"),
      expect.anything()
    );
    expect(refreshToken).not.toHaveBeenCalled();
    expect(await Integration.findByPk(linked.id)).not.toBe(null);
  });

  it("should recover a rejected token by refreshing it", async () => {
    const user = await buildUser();
    const linked = await buildLinkedAccount(user);
    const getIssue = vi
      .spyOn(GitHub, "getIssue")
      .mockRejectedValueOnce(requestError(401))
      .mockResolvedValueOnce(issue);
    vi.spyOn(GitHub, "refreshToken").mockResolvedValue({
      access_token: "refreshed-token",
      refresh_token: "next-refresh-token",
      expires_in: 28800,
    });

    const result = await GitHub.unfurl(issueUrl, user);
    expect(result).toMatchObject({ title: "Secret issue" });
    expect(getIssue).toHaveBeenLastCalledWith(
      "refreshed-token",
      expect.anything()
    );

    const authentication = await IntegrationAuthentication.findByPk(
      linked.authenticationId,
      { rejectOnEmpty: true }
    );
    expect(authentication.token).toEqual("refreshed-token");
    expect(authentication.refreshToken).toEqual("next-refresh-token");
  });

  // The recovery itself is shared with the other integrations and tested
  // with server/utils/linkedAccount.ts, these check what GitHub passes to it.
  it("should remove the linked account when the user revoked the app", async () => {
    const user = await buildUser();
    const linked = await buildLinkedAccount(user);
    vi.spyOn(GitHub, "getIssue").mockRejectedValue(requestError(401));
    // GitHub reports a revoked refresh token with its own code rather than
    // the "invalid_grant" of RFC 6749.
    vi.spyOn(GitHub, "refreshToken").mockRejectedValue(
      new OAuthTokenError("GitHub", "bad_refresh_token")
    );

    expect(await GitHub.unfurl(issueUrl, user)).toHaveProperty("error");
    expect(await Integration.findByPk(linked.id)).toBe(null);
  });

  it("should keep the linked account when the refresh is refused for another reason", async () => {
    const user = await buildUser();
    const linked = await buildLinkedAccount(user);
    const error = vi.spyOn(Logger, "error").mockImplementation(() => {});
    vi.spyOn(GitHub, "getIssue").mockRejectedValue(requestError(401));
    vi.spyOn(GitHub, "refreshToken").mockRejectedValue(
      new OAuthTokenError("GitHub", "incorrect_client_credentials")
    );

    expect(await GitHub.unfurl(issueUrl, user)).toHaveProperty("error");
    expect(await Integration.findByPk(linked.id)).not.toBe(null);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("GITHUB_CLIENT_SECRET"),
      expect.any(OAuthTokenError)
    );
  });

  it("should not pass other GitHub URLs on to later providers", async () => {
    const admin = await buildAdmin();
    await buildInstallation(admin);
    const user = await buildUser({ teamId: admin.teamId });

    expect(
      await GitHub.unfurl("https://github.com/secret/repo/commit/abc123", user)
    ).toHaveProperty("error");
    expect(
      await GitHub.unfurl("https://github.com/secret/repo", user)
    ).toHaveProperty("error");
  });
});

// Requests to GitHub's OAuth endpoints are answered by msw, which the test
// setup registers for every server test and resets between tests.
describe("GitHub.getProject", () => {
  const graphqlUrl = "https://api.github.com/graphql";
  const params = {
    type: UnfurlResourceType.Project as const,
    owner: "secret",
    ownerType: "orgs" as const,
    projectNumber: 3,
    url: projectUrl,
  };

  it("should return undefined for a project the user cannot see", async () => {
    // GitHub answers with a null project and an error at once.
    msw.use(
      http.post(graphqlUrl, () =>
        HttpResponse.json({
          data: { organization: { projectV2: null } },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["organization", "projectV2"],
              locations: [{ line: 3, column: 9 }],
              message: "Could not resolve to a ProjectV2 with the number 3.",
            },
          ],
        })
      )
    );

    expect(await GitHub.getProject("token", params)).toBeUndefined();
  });

  it("should fail when the token is rejected", async () => {
    msw.use(
      http.post(graphqlUrl, () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 })
      )
    );

    await expect(GitHub.getProject("token", params)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("should fail on an error that is not about visibility", async () => {
    msw.use(
      http.post(graphqlUrl, () =>
        HttpResponse.json({
          data: { organization: null },
          errors: [
            {
              type: "INSUFFICIENT_SCOPES",
              path: ["organization"],
              message: "Your token has not been granted the required scopes.",
            },
          ],
        })
      )
    );

    await expect(GitHub.getProject("token", params)).rejects.toThrow(
      "required scopes"
    );
  });
});

describe("GitHub token requests", () => {
  const tokenUrl = "https://github.com/login/oauth/access_token";
  const revokeUrl = `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`;

  it("should exchange a code for a token with its expiration", async () => {
    let params: URLSearchParams | undefined;
    msw.use(
      http.post(tokenUrl, async ({ request }) => {
        params = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: "access",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "refresh",
          refresh_token_expires_in: 15811200,
          scope: "",
        });
      })
    );

    expect(await GitHub.oauthAccess("code")).toEqual({
      access_token: "access",
      expires_in: 28800,
      refresh_token: "refresh",
    });
    expect(params?.get("code")).toEqual("code");
    expect(params?.get("client_id")).toEqual(env.GITHUB_CLIENT_ID);
  });

  it("should accept a token of an app that does not expire tokens", async () => {
    msw.use(
      http.post(tokenUrl, () =>
        HttpResponse.json({
          access_token: "access",
          token_type: "bearer",
          scope: "",
        })
      )
    );

    expect(await GitHub.oauthAccess("code")).toEqual({
      access_token: "access",
    });
  });

  it("should carry the OAuth error code of a refused token request", async () => {
    let grant: string | null = null;
    msw.use(
      http.post(tokenUrl, async ({ request }) => {
        grant = new URLSearchParams(await request.text()).get("grant_type");
        // GitHub reports token errors with status 200.
        return HttpResponse.json({
          error: "bad_refresh_token",
          error_description:
            "The refresh token passed is incorrect or expired.",
        });
      })
    );

    await expect(GitHub.refreshToken("refresh")).rejects.toMatchObject({
      code: "bad_refresh_token",
    });
    expect(grant).toEqual("refresh_token");
  });

  it("should fail on a token response that is not successful", async () => {
    msw.use(http.post(tokenUrl, () => HttpResponse.json({}, { status: 502 })));

    await expect(GitHub.refreshToken("refresh")).rejects.toThrow("status: 502");
  });

  it("should not take a server error for an OAuth error", async () => {
    // A proxy in front of GitHub that reports its errors as JSON.
    msw.use(
      http.post(tokenUrl, () =>
        HttpResponse.json({ error: "upstream timeout" }, { status: 502 })
      )
    );

    const promise = GitHub.refreshToken("refresh");
    await expect(promise).rejects.toThrow("status: 502");
    await expect(promise).rejects.not.toBeInstanceOf(OAuthTokenError);
  });

  it("should fail with the status when the token response is not JSON", async () => {
    // The page of a proxy in front of GitHub.
    msw.use(
      http.post(
        tokenUrl,
        () => new HttpResponse("<html>Bad Gateway</html>", { status: 502 })
      )
    );

    await expect(GitHub.refreshToken("refresh")).rejects.toThrow("status: 502");
  });

  it("should fail with the body when a successful token response is not JSON", async () => {
    // The page of a proxy in front of GitHub that answers with status 200.
    msw.use(
      http.post(
        tokenUrl,
        () => new HttpResponse("<html>Sign in</html>", { status: 200 })
      )
    );

    await expect(GitHub.refreshToken("refresh")).rejects.toThrow(
      "status: 200, <html>Sign in</html>"
    );
  });

  it("should revoke a token and ignore one GitHub no longer knows", async () => {
    const statuses = [204, 404];
    let body: string | undefined;
    let authorization: string | null = null;
    msw.use(
      http.delete(revokeUrl, async ({ request }) => {
        body = await request.text();
        authorization = request.headers.get("authorization");
        return new HttpResponse(null, { status: statuses.shift() });
      })
    );

    await GitHub.revokeToken("access");
    expect(JSON.parse(body ?? "{}")).toEqual({ access_token: "access" });
    expect(authorization).toEqual(
      `Basic ${Buffer.from(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`).toString("base64")}`
    );
    await expect(GitHub.revokeToken("gone")).resolves.toBeUndefined();
  });

  it("should fail revoking when GitHub refuses", async () => {
    msw.use(
      http.delete(revokeUrl, () => new HttpResponse(null, { status: 422 }))
    );

    await expect(GitHub.revokeToken("access")).rejects.toThrow("status: 422");
  });
});

describe("#urls.unfurl", () => {
  it("should not return content to a user without a linked account", async () => {
    const admin = await buildAdmin();
    await buildInstallation(admin);
    const user = await buildUser({ teamId: admin.teamId });
    vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);
    const iframely = vi.spyOn(Iframely, "requestResource");

    const res = await server.post("/api/urls.unfurl", user, {
      body: { url: issueUrl },
    });
    expect(res.status).toEqual(204);
    expect(iframely).not.toHaveBeenCalled();
  });

  it("should not leak a cached unfurl to another user", async () => {
    const admin = await buildAdmin();
    await buildInstallation(admin);
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });
    await buildLinkedAccount(userA);
    vi.spyOn(GitHub, "getIssue").mockResolvedValue(issue);

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

describe("GitHubIssueProvider", () => {
  it("should remove the accounts linked to a GitHub user that revoked the app", async () => {
    const admin = await buildAdmin();
    // The installation records the same account id, it is not a linked
    // account and must be kept.
    const installation = await buildInstallation(admin);
    const user = await buildUser({ teamId: admin.teamId });
    const linked = await buildLinkedAccount(user, { accountId: 1 });
    // The same GitHub account linked in another workspace is removed too.
    const elsewhere = await buildUser();
    const linkedElsewhere = await buildLinkedAccount(elsewhere, {
      accountId: 1,
    });
    const other = await buildUser({ teamId: admin.teamId });
    const otherLinked = await buildLinkedAccount(other, { accountId: 2 });

    await new GitHubIssueProvider().handleWebhook({
      payload: { action: "revoked", sender: { id: 1, login: "a" } },
      headers: { "x-github-event": "github_app_authorization" },
    });

    expect(await Integration.findByPk(linked.id, { paranoid: false })).toBe(
      null
    );
    expect(
      await IntegrationAuthentication.findByPk(linked.authenticationId)
    ).toBe(null);
    expect(
      await Integration.findByPk(linkedElsewhere.id, { paranoid: false })
    ).toBe(null);
    expect(await Integration.findByPk(otherLinked.id)).not.toBe(null);
    expect(await Integration.findByPk(installation.id)).not.toBe(null);
  });
});

describe("uninstall", () => {
  it("should revoke the token of a removed linked account", async () => {
    const user = await buildUser();
    const linked = await buildLinkedAccount(user);
    const revokeToken = vi
      .spyOn(GitHub, "revokeToken")
      .mockResolvedValue(undefined);

    await uninstall(linked);

    expect(revokeToken).toHaveBeenCalledWith(`token-${user.id}`);
  });

  it("should uninstall the app when an installation is removed and keep linked accounts", async () => {
    const admin = await buildAdmin();
    const installation = await buildInstallation(admin, 42);
    const user = await buildUser({ teamId: admin.teamId });
    const linked = await buildLinkedAccount(user);
    const requestAppUninstall = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(GitHub, "authenticateAsInstallation").mockResolvedValue({
      requestAppUninstall,
    } as unknown as Awaited<
      ReturnType<typeof GitHub.authenticateAsInstallation>
    >);

    await uninstall(installation);

    expect(requestAppUninstall).toHaveBeenCalledWith(42);
    expect(await Integration.findByPk(linked.id)).not.toBe(null);
  });
});
