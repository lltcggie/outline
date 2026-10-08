import { IntegrationService, IntegrationType } from "@shared/types";
import { createContext } from "@server/context";
import { Event, Integration, IntegrationAuthentication } from "@server/models";
import type { User } from "@server/models";
import { sequelize } from "@server/storage/database";
import { buildUser } from "@server/test/factories";
import { OAuthTokenError } from "./OAuthTokenError";
import { requestWithLinkedAccount, saveLinkedAccount } from "./linkedAccount";

/** A refusal of the service with the status it responded with. */
class ServiceError extends Error {
  constructor(public status: number) {
    super(`Service responded with ${status}`);
  }
}

const isUnauthorized = (err: unknown) =>
  err instanceof ServiceError && err.status === 401;

const refreshed = {
  access_token: "refreshed-token",
  refresh_token: "next-refresh-token",
  expires_in: 3600,
};

/**
 * Links an account of a service for a user.
 *
 * @param user the user linking the account.
 * @param options.expired whether the token has expired and must be refreshed.
 * @param options.refreshable whether a refresh token was issued.
 * @returns the linked account integration with its authentication.
 */
async function buildLinkedAccount(
  user: User,
  {
    expired = false,
    refreshable = true,
  }: { expired?: boolean; refreshable?: boolean } = {}
) {
  const authentication = await IntegrationAuthentication.create({
    service: IntegrationService.GitLab,
    userId: user.id,
    teamId: user.teamId,
    token: "token",
    ...(refreshable
      ? {
          refreshToken: "refresh-token",
          expiresAt: expired ? new Date(0) : new Date(Date.now() + 3600_000),
        }
      : {}),
  });
  const linkedAccount = await Integration.create<
    Integration<IntegrationType.LinkedAccount>
  >({
    service: IntegrationService.GitLab,
    type: IntegrationType.LinkedAccount,
    userId: user.id,
    teamId: user.teamId,
    authenticationId: authentication.id,
    settings: { gitlab: { account: { id: 1, name: "a", avatarUrl: "" } } },
  });
  linkedAccount.authentication = authentication;
  return linkedAccount;
}

describe("requestWithLinkedAccount", () => {
  it("should make the request with the stored token", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi.fn().mockResolvedValue("result");

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: false, result: "result" });
    expect(request).toHaveBeenCalledExactlyOnceWith("token");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("should refresh an expiring token before the request", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user, { expired: true });
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi.fn().mockResolvedValue("result");

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: false, result: "result" });
    expect(refresh).toHaveBeenCalledExactlyOnceWith("refresh-token");
    expect(request).toHaveBeenCalledExactlyOnceWith("refreshed-token");
  });

  it("should recover a rejected token by refreshing it and retry once", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ServiceError(401))
      .mockResolvedValueOnce("result");

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: false, result: "result" });
    expect(refresh).toHaveBeenCalledExactlyOnceWith("refresh-token");
    expect(request).toHaveBeenNthCalledWith(1, "token");
    expect(request).toHaveBeenNthCalledWith(2, "refreshed-token");

    const authentication = await linkedAccount.authentication.reload();
    expect(authentication.token).toEqual("refreshed-token");
    expect(authentication.refreshToken).toEqual("next-refresh-token");
    expect(authentication.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("should keep the refresh token when the refresh does not issue a new one", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi
      .fn()
      .mockResolvedValue({ access_token: "refreshed-token", expires_in: 3600 });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ServiceError(401))
      .mockResolvedValueOnce("result");

    await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    const authentication = await linkedAccount.authentication.reload();
    expect(authentication.token).toEqual("refreshed-token");
    expect(authentication.refreshToken).toEqual("refresh-token");
  });

  it("should not retry more than once", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi.fn().mockRejectedValue(new ServiceError(401));

    await expect(
      requestWithLinkedAccount({
        linkedAccount,
        actor: user,
        refresh,
        isUnauthorized,
        request,
      })
    ).rejects.toBeInstanceOf(ServiceError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await Integration.findByPk(linkedAccount.id)).not.toBeNull();
  });

  it("should use the token a concurrent recovery stored instead of refreshing again", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        // Another request recovered from the same rejection meanwhile, which
        // may have spent a refresh token the service invalidates once used.
        await IntegrationAuthentication.update(
          {
            token: "concurrent-token",
            refreshToken: "concurrent-refresh-token",
          },
          { where: { id: linkedAccount.authenticationId } }
        );
        throw new ServiceError(401);
      })
      .mockResolvedValueOnce("result");

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: false, result: "result" });
    expect(refresh).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith("concurrent-token");
    const authentication = await linkedAccount.authentication.reload();
    expect(authentication.refreshToken).toEqual("concurrent-refresh-token");
  });

  it("should remove the account when the refresh token was revoked", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi
      .fn()
      .mockRejectedValue(new OAuthTokenError("Service", "invalid_grant"));
    const request = vi.fn().mockRejectedValue(new ServiceError(401));

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: true });
    expect(request).toHaveBeenCalledTimes(1);

    // Deleted with an event, as from the settings.
    expect(await Integration.findByPk(linkedAccount.id)).toBeNull();
    const deleted = await Integration.findByPk(linkedAccount.id, {
      paranoid: false,
    });
    expect(deleted?.deletedAt).toBeTruthy();
    expect(
      await Event.findOne({
        where: {
          name: "integrations.delete",
          modelId: linkedAccount.id,
          actorId: user.id,
        },
      })
    ).not.toBeNull();
  });

  it("should tell a revoked refresh token apart with the given predicate", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi
      .fn()
      .mockRejectedValue(new OAuthTokenError("Service", "bad_refresh_token"));
    const request = vi.fn().mockRejectedValue(new ServiceError(401));

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      isRevoked: (err) =>
        err instanceof OAuthTokenError && err.code === "bad_refresh_token",
      request,
    });

    expect(outcome).toEqual({ removed: true });
    expect(await Integration.findByPk(linkedAccount.id)).toBeNull();
  });

  it("should remove the account when the stored refresh token is gone meanwhile", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        await IntegrationAuthentication.update(
          { refreshToken: "" },
          { where: { id: linkedAccount.authenticationId } }
        );
        throw new ServiceError(401);
      })
      .mockResolvedValueOnce("result");

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: true });
    expect(refresh).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await Integration.findByPk(linkedAccount.id)).toBeNull();
  });

  it("should not remove the account again when a concurrent recovery removed it", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi.fn().mockImplementationOnce(async () => {
      // Another request found the refresh token revoked meanwhile and removed
      // the account, which leaves its authentication in place until the
      // removal is processed.
      const concurrent = await Integration.findByPk(linkedAccount.id, {
        rejectOnEmpty: true,
      });
      await concurrent.destroyWithCtx(createContext({ user }));
      throw new ServiceError(401);
    });

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: true });
    expect(refresh).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      await Event.count({
        where: { name: "integrations.delete", modelId: linkedAccount.id },
      })
    ).toEqual(1);
  });

  it("should remove the account under the lock so that a concurrent recovery finds it gone", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const request = vi.fn().mockRejectedValue(new ServiceError(401));
    let concurrent: Promise<unknown> | undefined;
    const refresh = vi.fn().mockImplementation(async () => {
      // Another request is refused while this recovery holds the lock. It
      // waits for the lock and must find the account removed rather than
      // refresh with the same revoked token and remove it again.
      concurrent = requestWithLinkedAccount({
        linkedAccount,
        actor: user,
        refresh,
        isUnauthorized,
        request,
      });
      throw new OAuthTokenError("Service", "invalid_grant");
    });

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: true });
    expect(await concurrent).toEqual({ removed: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      await Event.count({
        where: { name: "integrations.delete", modelId: linkedAccount.id },
      })
    ).toEqual(1);
  });

  it("should retry with the token the user linked again meanwhile instead of removing the account", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user, {
      refreshable: false,
    });
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        // The user revoked the application and linked the account again
        // before the rejection of the old token arrived.
        await IntegrationAuthentication.update(
          { token: "relinked-token" },
          { where: { id: linkedAccount.authenticationId } }
        );
        throw new ServiceError(401);
      })
      .mockResolvedValueOnce("result");

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: false, result: "result" });
    expect(refresh).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith("relinked-token");
    expect(await Integration.findByPk(linkedAccount.id)).not.toBeNull();
  });

  it("should remove the account when a token that cannot be refreshed is rejected", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user, {
      refreshable: false,
    });
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const request = vi.fn().mockRejectedValue(new ServiceError(401));

    const outcome = await requestWithLinkedAccount({
      linkedAccount,
      actor: user,
      refresh,
      isUnauthorized,
      request,
    });

    expect(outcome).toEqual({ removed: true });
    expect(refresh).not.toHaveBeenCalled();
    expect(await Integration.findByPk(linkedAccount.id)).toBeNull();
  });

  // Wrong application credentials are refused with a different code, which
  // must not remove the accounts of every user of the installation, and a
  // failure to reach the token endpoint says nothing about the account.
  it.each([
    new OAuthTokenError("Service", "invalid_client"),
    new Error("socket hang up"),
  ])(
    "should keep the account when the refresh fails with %s",
    async (failure) => {
      const user = await buildUser();
      const linkedAccount = await buildLinkedAccount(user);
      const refresh = vi.fn().mockRejectedValue(failure);
      const request = vi.fn().mockRejectedValue(new ServiceError(401));

      await expect(
        requestWithLinkedAccount({
          linkedAccount,
          actor: user,
          refresh,
          isUnauthorized,
          request,
        })
      ).rejects.toBe(failure);
      expect(await Integration.findByPk(linkedAccount.id)).not.toBeNull();
      const authentication = await linkedAccount.authentication.reload();
      expect(authentication.token).toEqual("token");
    }
  );

  it("should pass on a refusal that is not unauthorized without refreshing", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const refusal = new ServiceError(404);
    const request = vi.fn().mockRejectedValue(refusal);

    await expect(
      requestWithLinkedAccount({
        linkedAccount,
        actor: user,
        refresh,
        isUnauthorized,
        request,
      })
    ).rejects.toBe(refusal);
    expect(refresh).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(await Integration.findByPk(linkedAccount.id)).not.toBeNull();
  });
});

describe("saveLinkedAccount", () => {
  const settings = {
    gitlab: { account: { id: 1, name: "b", avatarUrl: "" } },
  };
  const tokens = { token: "new-token", refreshToken: "new-refresh-token" };

  /**
   * Stores the account of a user in a transaction of its own.
   *
   * @param user the user linking the account.
   * @param existing the user's existing linked account, as found earlier.
   * @returns the access token the existing account held, when replaced.
   */
  function save(
    user: User,
    existing: Integration<IntegrationType.LinkedAccount> | undefined
  ) {
    return sequelize.transaction((transaction) =>
      saveLinkedAccount({
        user,
        service: IntegrationService.GitLab,
        existing,
        settings,
        tokens,
        transaction,
      })
    );
  }

  /**
   * Finds the accounts a user has linked.
   *
   * @param user the user that linked the accounts.
   * @returns the linked account integrations.
   */
  function findLinkedAccounts(user: User) {
    return Integration.findAll<Integration<IntegrationType.LinkedAccount>>({
      where: {
        service: IntegrationService.GitLab,
        type: IntegrationType.LinkedAccount,
        userId: user.id,
      },
    });
  }

  it("should update the existing account and return the token it held", async () => {
    const user = await buildUser();
    const linkedAccount = await buildLinkedAccount(user);

    expect(await save(user, linkedAccount)).toEqual("token");

    const [linked] = await findLinkedAccounts(user);
    expect(linked.id).toEqual(linkedAccount.id);
    expect(linked.settings).toEqual(settings);
    const authentication = await linkedAccount.authentication.reload();
    expect(authentication.token).toEqual("new-token");
    expect(authentication.refreshToken).toEqual("new-refresh-token");
  });

  it("should create the account when there is none", async () => {
    const user = await buildUser();

    expect(await save(user, undefined)).toBeUndefined();

    const [linked] = await findLinkedAccounts(user);
    expect(linked.settings).toEqual(settings);
    const authentication = await IntegrationAuthentication.findByPk(
      linked.authenticationId,
      { rejectOnEmpty: true }
    );
    expect(authentication.token).toEqual("new-token");
  });

  // The account was found before the lock was taken, so it may have been
  // removed meanwhile: marked deleted by a recovery that found its token
  // revoked, which leaves the authentication until the deletion is processed,
  // or deleted with its authentication by the webhook of the service. Neither
  // the removed rows nor the token they hold must be written to, the new
  // account is created instead.
  it.each([false, true])(
    "should create a new account when the existing one was removed meanwhile (force: %s)",
    async (force) => {
      const user = await buildUser();
      const linkedAccount = await buildLinkedAccount(user);
      await linkedAccount.destroy({ force });

      expect(await save(user, linkedAccount)).toBeUndefined();

      const [linked, ...others] = await findLinkedAccounts(user);
      expect(others).toHaveLength(0);
      expect(linked.id).not.toEqual(linkedAccount.id);
      expect(linked.settings).toEqual(settings);
      const authentication = await IntegrationAuthentication.findByPk(
        linked.authenticationId,
        { rejectOnEmpty: true }
      );
      expect(authentication.token).toEqual("new-token");
      // The removed account is left as it was.
      const removed = await IntegrationAuthentication.findByPk(
        linkedAccount.authenticationId
      );
      expect(removed?.token).toEqual(force ? undefined : "token");
    }
  );

  it("should replace an existing account whose authentication is missing", async () => {
    const user = await buildUser();
    const linkedAccount = await Integration.create<
      Integration<IntegrationType.LinkedAccount>
    >({
      service: IntegrationService.GitLab,
      type: IntegrationType.LinkedAccount,
      userId: user.id,
      teamId: user.teamId,
      settings: { gitlab: { account: { id: 1, name: "a", avatarUrl: "" } } },
    });

    expect(await save(user, linkedAccount)).toBeUndefined();

    const [linked, ...others] = await findLinkedAccounts(user);
    expect(others).toHaveLength(0);
    expect(linked.id).not.toEqual(linkedAccount.id);
    expect(
      await Integration.findByPk(linkedAccount.id, { paranoid: false })
    ).toBeNull();
  });
});
