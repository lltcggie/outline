import { addSeconds } from "date-fns";
import {
  Op,
  type Attributes,
  type Transaction,
  type WhereOptions,
} from "sequelize";
import type { IntegrationService, IntegrationSettings } from "@shared/types";
import { IntegrationType } from "@shared/types";
import { createContext } from "@server/context";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import { Integration, IntegrationAuthentication } from "@server/models";
import type { TokenRefreshCallback } from "@server/models/IntegrationAuthentication";
import { sequelize } from "@server/storage/database";
import { OAuthTokenError } from "./OAuthTokenError";
import { clearUnfurlCacheAfterCommit } from "./unfurlCache";

/** The outcome of a request made with the token of a linked account. */
export type LinkedAccountRequestOutcome<T> =
  | { removed: false; result: T }
  | {
      /**
       * The service no longer accepts the account's tokens, so the linked
       * account was removed and the user has to connect again.
       */
      removed: true;
    };

export interface LinkedAccountRequestOptions<T> {
  /** The linked account whose token the request is made with. */
  linkedAccount: LinkedAccount;
  /** The user the account belongs to, which the removal is recorded for. */
  actor: User;
  /** Obtains a new access token with a refresh token, as for `refreshTokenIfNeeded`. */
  refresh: TokenRefreshCallback;
  /** Whether the service rejected the access token the request was made with. */
  isUnauthorized: (err: unknown) => boolean;
  /**
   * Whether the service refused a refresh because the refresh token is no
   * longer valid, as happens when the user revoked the application. By default
   * this is an `OAuthTokenError` with the code "invalid_grant" of RFC 6749.
   */
  isRevoked?: (err: unknown) => boolean;
  /** Makes the request with an access token. */
  request: (token: string) => Promise<T>;
}

/** The tokens issued for a linked account, as stored in its authentication. */
export interface LinkedAccountTokens {
  /** The access token. */
  token: string;
  /**
   * The refresh token, when the service issues one. Null rather than unset
   * when it does not, so that updating an account clears the one it held.
   */
  refreshToken?: string | null;
  /** When the access token expires, null or unset when it does not. */
  expiresAt?: Date | null;
  /** The scopes the token was granted. */
  scopes?: string[];
}

/** The account a user linked, and where to store it. */
export interface SaveLinkedAccountOptions {
  /** The user linking the account, whose own account is the only one written. */
  user: User;
  /** The service the account belongs to. */
  service: IntegrationService;
  /**
   * The user's existing linked account, which is updated, or replaced when
   * its authentication is missing. It is read again under a lock, as it may
   * have been removed since it was found.
   */
  existing?: LinkedAccount | null;
  /** The settings that describe the account. */
  settings: IntegrationSettings<IntegrationType.LinkedAccount>;
  /** The tokens issued for the account. */
  tokens: LinkedAccountTokens;
  /** The transaction to write within. */
  transaction: Transaction;
}

/**
 * Makes a request to a service with the access token of a linked account, and
 * recovers when the service rejects the token although it should still be
 * valid, which happens when the user revoked the application in the service,
 * or when an earlier refresh failed and the expired token was kept.
 *
 * The token is refreshed ahead of its expiry as usual. When the request is
 * refused as unauthorized the token is refreshed once more and the request is
 * retried once. When the service refuses that refresh because the refresh
 * token is no longer valid, or when the account has no refresh token to
 * restore its access with, the linked account is removed, see
 * `removeRevokedAccount`.
 *
 * @param options the account, the request and the predicates that tell the
 * refusals of the service apart.
 * @returns the result of the request, or that the account was removed.
 * @throws the error of the request when it was not refused as unauthorized or
 * when the retry fails, and the error of a refresh refused for another reason
 * than a revoked token, such as a network error or wrong application
 * credentials, in which case the account is kept.
 */
export async function requestWithLinkedAccount<T>(
  options: LinkedAccountRequestOptions<T>
): Promise<LinkedAccountRequestOutcome<T>> {
  const { linkedAccount, refresh, isUnauthorized, request } = options;
  const token =
    await linkedAccount.authentication.refreshTokenIfNeeded(refresh);

  try {
    return { removed: false, result: await request(token) };
  } catch (err) {
    if (!isUnauthorized(err)) {
      throw err;
    }

    const recovered = await recoverAccess(options, token);
    if (recovered === undefined) {
      return { removed: true };
    }
    return { removed: false, result: await request(recovered) };
  }
}

/**
 * Finds the accounts users linked for a service in a team, with their
 * authentication when it still exists.
 *
 * @param service the service the accounts belong to.
 * @param params.teamId the team to search.
 * @param params.userId the user to limit the search to, all users when unset.
 * @param options the query options.
 * @returns the linked account integrations, with their authentication if any.
 */
export async function findLinkedAccounts(
  service: IntegrationService,
  { teamId, userId }: { teamId: string; userId?: string },
  options: { transaction?: Transaction } = {}
): Promise<LinkedAccount[]> {
  return Integration.findAll<LinkedAccount>({
    where: {
      service,
      type: IntegrationType.LinkedAccount,
      teamId,
      ...(userId ? { userId } : {}),
    },
    include: [
      {
        model: IntegrationAuthentication,
        as: "authentication",
        required: false,
      },
    ],
    transaction: options.transaction,
  });
}

/**
 * Stores the account a user linked, by updating the user's existing linked
 * account or by creating one, which replaces an existing account whose
 * authentication is missing. The existing account is locked first, in the
 * order in which `requestWithLinkedAccount` locks its rows when it recovers
 * or removes an account, so that one running at the same time cannot
 * deadlock with this and, when it removed the account meanwhile, the removed
 * rows are not written to: the new account is created instead.
 *
 * @param options the user, the account and the transaction to write within.
 * @returns the access token the existing account held, when the new one
 * replaced it.
 */
export async function saveLinkedAccount({
  user,
  service,
  existing,
  settings,
  tokens,
  transaction,
}: SaveLinkedAccountOptions): Promise<string | undefined> {
  // The account was found without a lock, so it may have been removed since,
  // by a recovery that found its token revoked or by the webhook of the
  // service. A removal that is only marked deleted leaves the authentication
  // row behind until the deletion is processed, so neither row is updated
  // once the integration is gone.
  const locked = existing
    ? await Integration.findByPk<LinkedAccount>(existing.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : null;
  const lockedAuthentication = locked?.authenticationId
    ? await IntegrationAuthentication.findByPk(locked.authenticationId, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      })
    : null;

  if (locked && lockedAuthentication) {
    const replacedToken =
      lockedAuthentication.token !== tokens.token
        ? lockedAuthentication.token
        : undefined;
    locked.settings = settings;
    await locked.save({ transaction });
    await lockedAuthentication.update(tokens, { transaction });
    return replacedToken;
  }

  if (locked) {
    await destroyLinkedAccounts([locked], { transaction });
  }

  const authentication = await IntegrationAuthentication.create(
    { service, userId: user.id, teamId: user.teamId, ...tokens },
    { transaction }
  );
  await Integration.createWithCtx<LinkedAccount>(
    createContext({ user, transaction }),
    {
      service,
      type: IntegrationType.LinkedAccount,
      userId: user.id,
      teamId: user.teamId,
      authenticationId: authentication.id,
      settings,
    }
  );
  return undefined;
}

/**
 * Removes linked accounts together with their stored tokens, at once and
 * without an event, such as accounts that are replaced or whose tokens the
 * service has already invalidated.
 *
 * @param linkedAccounts the linked account integrations to remove.
 * @param options the query options.
 */
export async function destroyLinkedAccounts(
  linkedAccounts: LinkedAccount[],
  options: { transaction?: Transaction } = {}
): Promise<void> {
  for (const linkedAccount of linkedAccounts) {
    // Destroying with force also removes the stored token.
    await linkedAccount.destroy({
      transaction: options.transaction,
      force: true,
    });
  }
}

/**
 * Removes the linked accounts that match a condition, such as those of a user
 * the service reports as deleted or as having revoked the application, together
 * with their stored tokens, and clears the unfurls cached with them once the
 * removal commits. The accounts are locked while they are removed, so that a
 * recovery of one of their tokens running at the same time, see
 * `requestWithLinkedAccount`, finds them gone rather than refreshing them.
 *
 * @param where the condition the accounts must match, besides being linked
 * accounts.
 * @param options.filter keeps only the accounts for which it returns true, for
 * conditions that cannot be expressed in the query.
 */
export async function removeLinkedAccounts(
  where: WhereOptions<Attributes<LinkedAccount>>,
  options: { filter?: (linkedAccount: LinkedAccount) => boolean } = {}
): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    const found = await Integration.findAll<LinkedAccount>({
      where: { [Op.and]: [where, { type: IntegrationType.LinkedAccount }] },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    const linkedAccounts = options.filter
      ? found.filter(options.filter)
      : found;

    await destroyLinkedAccounts(linkedAccounts, { transaction });

    clearUnfurlCacheAfterCommit(transaction, linkedAccounts);
  });
}

/**
 * Whether an error is a refusal of the OAuth token endpoint with the error
 * code "invalid_grant", which RFC 6749 §5.2 defines for a refresh token that
 * is invalid, expired or revoked.
 *
 * @param err the error a refresh threw.
 * @returns true if the refresh token is no longer valid.
 */
function isInvalidGrant(err: unknown): boolean {
  return err instanceof OAuthTokenError && err.code === "invalid_grant";
}

/**
 * Refreshes the access token of a linked account after the service rejected
 * it. Services may invalidate a refresh token once it is used, so recoveries
 * are serialized on the account's rows, and one that finds the rejected token
 * already replaced by a concurrent recovery uses the replacement rather than
 * spending the new refresh token. An account that cannot be recovered is
 * removed under the same lock, so that a concurrent recovery finds it gone
 * rather than removing it a second time.
 *
 * @param options the options of the request whose token was rejected.
 * @param rejectedToken the access token the service rejected.
 * @returns the new access token, or undefined when the account was removed.
 * @throws the error of a refresh that failed for another reason than a
 * revoked token.
 */
async function recoverAccess<T>(
  {
    linkedAccount,
    actor,
    refresh,
    isRevoked = isInvalidGrant,
  }: LinkedAccountRequestOptions<T>,
  rejectedToken: string
): Promise<string | undefined> {
  return sequelize.transaction(async (transaction) => {
    // The integration row is locked before the authentication row, which is
    // the order in which removing an account deletes them, so that a removal
    // running at the same time, such as the one a revocation webhook
    // triggers, cannot deadlock with the recovery. A concurrent recovery
    // removed the account meanwhile when the integration is gone: the removal
    // only marks it deleted and leaves its authentication until the deletion
    // is processed.
    const integration = await Integration.findByPk(linkedAccount.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!integration) {
      return undefined;
    }
    const locked = await IntegrationAuthentication.findByPk(
      linkedAccount.authentication.id,
      { transaction, lock: transaction.LOCK.UPDATE }
    );
    if (!locked) {
      return undefined;
    }
    // The rejected token was replaced meanwhile, by a concurrent recovery or
    // by the user linking the account again.
    if (locked.token !== rejectedToken) {
      return locked.token;
    }

    // Without a refresh token, which a service that does not expire tokens
    // never issues, the access cannot be restored.
    if (locked.refreshToken) {
      Logger.info(
        "plugins",
        `Refreshing the rejected ${linkedAccount.service} access token of user ${actor.id}`
      );
      try {
        const refreshed = await refresh(locked.refreshToken);
        await locked.update(
          {
            token: refreshed.access_token,
            refreshToken: refreshed.refresh_token || locked.refreshToken,
            expiresAt: addSeconds(Date.now(), refreshed.expires_in),
          },
          { transaction }
        );
        return refreshed.access_token;
      } catch (err) {
        if (!isRevoked(err)) {
          throw err;
        }
      }
    }

    await removeRevokedAccount(linkedAccount, actor, transaction);
    return undefined;
  });
}

/**
 * Removes a linked account whose access was revoked in the service, the same
 * way as when the user disconnects it in their settings: the integration is
 * deleted with an event, and the processor of that event clears the previews
 * fetched with the account and removes its stored tokens.
 *
 * @param linkedAccount the linked account to remove.
 * @param actor the user the account belongs to.
 * @param transaction the transaction that holds the lock on the account's
 * authentication.
 */
async function removeRevokedAccount(
  linkedAccount: LinkedAccount,
  actor: User,
  transaction: Transaction
): Promise<void> {
  Logger.info(
    "plugins",
    `${linkedAccount.service} access of user ${actor.id} was revoked, removing the linked account`
  );
  await linkedAccount.destroyWithCtx(
    createContext({ user: actor, transaction })
  );
}

type LinkedAccount = Integration<IntegrationType.LinkedAccount>;
