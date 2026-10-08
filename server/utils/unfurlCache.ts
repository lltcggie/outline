import type { Transaction } from "sequelize";
import { toError } from "@shared/utils/error";
import Logger from "@server/logging/Logger";
import { CacheHelper } from "./CacheHelper";
import { RedisPrefixHelper } from "./RedisPrefixHelper";

/** The cached unfurls of one user, or of every member of a team. */
export interface UnfurlCacheScope {
  /** The team whose cached unfurls are cleared. */
  teamId: string;
  /** The user whose cached unfurls are cleared, every member when unset. */
  userId?: string;
}

/**
 * Clears cached unfurls once a transaction that makes them stale commits, such
 * as one that links or removes an account previews were fetched with. The
 * cache is only cleared after the commit, as a request served between the
 * clearing and the commit would cache the stale state again. A failure to
 * reach the cache is logged rather than thrown: the write is committed by
 * then and the stale entries expire on their own, so it must not fail the
 * caller after the fact.
 *
 * @param transaction the transaction after whose commit the cache is cleared.
 * @param scopes the users or teams whose cached unfurls are cleared.
 */
export function clearUnfurlCacheAfterCommit(
  transaction: Transaction,
  scopes: UnfurlCacheScope[]
): void {
  transaction.afterCommit(async () => {
    try {
      await Promise.all(
        scopes.map((scope) =>
          CacheHelper.clearData(
            RedisPrefixHelper.getUnfurlPrefix(scope.teamId, scope.userId)
          )
        )
      );
    } catch (err) {
      Logger.warn("Failed to clear cached unfurls", toError(err));
    }
  });
}
