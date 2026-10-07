// @vitest-isolate true
import { IntegrationService, IntegrationType } from "@shared/types";
import { Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import { buildAdmin, buildUser, buildViewer } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { AsanaOAuthNonceCookie, AsanaUtils } from "../../shared/AsanaUtils";
import { Asana } from "../asana";

const server = getTestServer();

/**
 * Completes the OAuth callback for a user with a mocked Asana account.
 *
 * @param user the user completing the callback.
 * @param accountId the gid of the Asana account returned by Asana.
 * @returns the response.
 */
async function callback(user: User, accountId: string) {
  vi.spyOn(Asana, "oauthAccess").mockResolvedValue({
    access_token: `token-${user.id}`,
    expires_in: 3600,
    refresh_token: `refresh-${user.id}`,
  });
  vi.spyOn(Asana, "getCurrentUser").mockResolvedValue({
    gid: accountId,
    name: `asana-${accountId}`,
    email: `asana-${accountId}@example.com`,
    photo: { image_128x128: "https://example.com/avatar.png" },
  });

  const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
  return server.get(
    `/api/asana.callback?state=${encodeURIComponent(state)}&code=123`,
    user,
    {
      redirect: "manual",
      headers: { Cookie: `${AsanaOAuthNonceCookie}=nonce` },
    }
  );
}

/**
 * Finds the Asana accounts linked by a user, however many there are.
 *
 * @param user the user to find linked accounts for.
 * @returns the linked account integrations with their authentication.
 */
function findLinkedAccounts(user: User) {
  return Integration.findAll<Integration<IntegrationType.LinkedAccount>>({
    where: {
      service: IntegrationService.Asana,
      type: IntegrationType.LinkedAccount,
      teamId: user.teamId,
      userId: user.id,
    },
    include: [
      {
        model: IntegrationAuthentication,
        as: "authentication",
        required: false,
      },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#asana.authorize", () => {
  it("should allow any member to link their account", async () => {
    const viewer = await buildViewer();

    const res = await server.post("/api/asana.authorize", viewer);
    const body = await res.json();
    expect(res.status).toEqual(200);

    const redirectUrl = new URL(body.data.redirectUrl);
    expect(redirectUrl.origin + redirectUrl.pathname).toEqual(
      AsanaUtils.authorizeUrl
    );
    expect(redirectUrl.searchParams.get("client_id")).toEqual("123");
    expect(redirectUrl.searchParams.get("scope")).toEqual(
      "tasks:read projects:read users:read"
    );
    expect(
      AsanaUtils.parseState(redirectUrl.searchParams.get("state")!)?.teamId
    ).toEqual(viewer.teamId);
    expect(res.headers.get("set-cookie")).toContain(AsanaOAuthNonceCookie);
  });

  it("should require authentication", async () => {
    const res = await server.post("/api/asana.authorize");
    expect(res.status).toEqual(401);
  });
});

describe("#asana.callback", () => {
  it("should reject callback when state nonce does not match cookie", async () => {
    const user = await buildUser();
    const state = JSON.stringify({
      teamId: user.teamId,
      nonce: "attacker-nonce",
    });
    const res = await server.get(
      `/api/asana.callback?state=${encodeURIComponent(state)}&code=123`,
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
      `/api/asana.callback?state=${encodeURIComponent(state)}&code=123`,
      user,
      { redirect: "manual" }
    );
    expect(res.status).toEqual(400);
  });

  it("should fail when state is not valid JSON", async () => {
    const user = await buildUser();
    const res = await server.get(
      `/api/asana.callback?state=bad&code=123`,
      user,
      {
        redirect: "manual",
      }
    );
    expect(res.status).toEqual(400);
  });

  it("should redirect with the error returned by Asana", async () => {
    const user = await buildUser();
    const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
    const res = await server.get(
      `/api/asana.callback?state=${encodeURIComponent(state)}&error=access_denied`,
      user,
      { redirect: "manual" }
    );
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).toContain("error=access_denied");
  });

  it("should store the token as the user's own linked account", async () => {
    const user = await buildUser();

    const res = await callback(user, "1");
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).not.toContain("error");

    const [linked] = await findLinkedAccounts(user);
    expect(linked.settings.asana?.account).toEqual({
      id: "1",
      name: "asana-1",
      email: "asana-1@example.com",
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(linked.authentication.token).toEqual(`token-${user.id}`);
    expect(linked.authentication.refreshToken).toEqual(`refresh-${user.id}`);
    expect(linked.authentication.expiresAt).toBeTruthy();
  });

  it("should link an account whose email and photo are missing", async () => {
    const user = await buildUser();
    vi.spyOn(Asana, "oauthAccess").mockResolvedValue({
      access_token: `token-${user.id}`,
      expires_in: 3600,
      refresh_token: `refresh-${user.id}`,
    });
    vi.spyOn(Asana, "getCurrentUser").mockResolvedValue({
      gid: "1",
      name: "asana-1",
      email: null,
      photo: null,
    });

    const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
    const res = await server.get(
      `/api/asana.callback?state=${encodeURIComponent(state)}&code=123`,
      user,
      {
        redirect: "manual",
        headers: { Cookie: `${AsanaOAuthNonceCookie}=nonce` },
      }
    );
    expect(res.headers.get("location")).not.toContain("error");

    const [linked] = await findLinkedAccounts(user);
    expect(linked.settings.asana?.account).toEqual({
      id: "1",
      name: "asana-1",
    });
  });

  it("should update the user's existing linked account", async () => {
    const user = await buildUser();

    await callback(user, "1");
    await callback(user, "2");

    const linked = await findLinkedAccounts(user);
    expect(linked).toHaveLength(1);
    expect(linked[0].settings.asana?.account.id).toEqual("2");
  });

  it("should not overwrite another user's linked account", async () => {
    const admin = await buildAdmin();
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });

    await callback(userA, "1");
    await callback(userB, "2");

    const [linkedA] = await findLinkedAccounts(userA);
    const [linkedB] = await findLinkedAccounts(userB);
    expect(linkedA.authentication.token).toEqual(`token-${userA.id}`);
    expect(linkedB.authentication.token).toEqual(`token-${userB.id}`);
  });

  it("should reject an Asana account already linked by another user", async () => {
    const admin = await buildAdmin();
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });

    await callback(userA, "1");
    const res = await callback(userB, "1");

    expect(res.headers.get("location")).toContain("duplicate_account");
    expect(await findLinkedAccounts(userB)).toHaveLength(0);
  });

  it("should allow the same Asana account in another workspace", async () => {
    const userA = await buildUser();
    const userB = await buildUser();

    await callback(userA, "1");
    const res = await callback(userB, "1");

    expect(res.headers.get("location")).not.toContain("error");
    expect(await findLinkedAccounts(userB)).toHaveLength(1);
  });

  it("should redirect with an error when Asana rejects the code", async () => {
    const user = await buildUser();
    vi.spyOn(Asana, "oauthAccess").mockRejectedValue(new Error("rejected"));

    const state = JSON.stringify({ teamId: user.teamId, nonce: "nonce" });
    const res = await server.get(
      `/api/asana.callback?state=${encodeURIComponent(state)}&code=123`,
      user,
      {
        redirect: "manual",
        headers: { Cookie: `${AsanaOAuthNonceCookie}=nonce` },
      }
    );
    expect(res.headers.get("location")).toContain("error=unknown");
    expect(await findLinkedAccounts(user)).toHaveLength(0);
  });

  it("should not keep a token when linking fails part way through", async () => {
    const user = await buildUser();
    vi.spyOn(Integration, "createWithCtx").mockRejectedValue(
      new Error("database unavailable")
    );

    const res = await callback(user, "1");

    expect(res.headers.get("location")).toContain("error=unknown");
    expect(await findLinkedAccounts(user)).toHaveLength(0);
    // The authentication created before the failure is rolled back.
    expect(
      await IntegrationAuthentication.count({
        where: { service: IntegrationService.Asana, userId: user.id },
      })
    ).toEqual(0);
  });
});

describe("#integrations.list", () => {
  it("should not return other users' Asana accounts", async () => {
    const admin = await buildAdmin();
    const userA = await buildUser({ teamId: admin.teamId });
    const userB = await buildUser({ teamId: admin.teamId });
    await callback(userA, "1");

    const res = await server.post("/api/integrations.list", userB, {
      body: { service: IntegrationService.Asana },
    });
    const body = await res.json();
    expect(res.status).toEqual(200);
    expect(JSON.stringify(body.data)).not.toContain("asana-1");

    const own = await server.post("/api/integrations.list", userA, {
      body: { service: IntegrationService.Asana },
    });
    const ownBody = await own.json();
    expect(ownBody.data).toHaveLength(1);
    expect(ownBody.data[0].settings.asana.account.name).toEqual("asana-1");
  });

  it("should let a user remove their own linked account", async () => {
    const user = await buildUser();
    await callback(user, "1");
    const [linked] = await findLinkedAccounts(user);

    const res = await server.post("/api/integrations.delete", user, {
      body: { id: linked.id },
    });
    expect(res.status).toEqual(200);
  });
});
