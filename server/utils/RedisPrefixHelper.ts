/**
 * Helper class for Redis cache key generation.
 */
export class RedisPrefixHelper {
  /**
   * Gets key against which unfurl response for the given url is stored. A
   * response that depends on the access of the user that requested it is
   * never shared between users.
   *
   * @param teamId The team ID to generate a key for.
   * @param userId The ID of the user the response was fetched for, or
   * undefined for a response that is shared within the team.
   * @param url The url to generate a key for.
   * @returns the cache key string.
   */
  public static getUnfurlKey(
    teamId: string,
    userId: string | undefined,
    url: string
  ) {
    return userId
      ? `${this.getUnfurlPrefix(teamId, userId)}${url}`
      : `${this.getUnfurlPrefix(teamId)}shared:${url}`;
  }

  /**
   * Gets the prefix shared by cached unfurl responses, used to clear them.
   *
   * @param teamId The team ID to scope the prefix to, all teams when omitted.
   * @param userId The user ID to scope the prefix to, all users when omitted.
   * @returns the cache key prefix.
   */
  public static getUnfurlPrefix(teamId?: string, userId?: string) {
    if (!teamId) {
      return "unfurl:";
    }
    if (!userId) {
      return `unfurl:${teamId}:`;
    }
    return `unfurl:${teamId}:${userId}:`;
  }

  /**
   * Gets key for caching collection documents structure.
   *
   * @param collectionId The collection ID to generate a key for.
   * @returns the cache key string.
   */
  public static getCollectionDocumentsKey(collectionId: string) {
    return `cd:${collectionId}`;
  }

  /**
   * Gets key for caching embed check results. This is a global cache key
   * (not team-specific) since embed headers are the same for all users.
   *
   * @param url The URL to generate a cache key for.
   * @returns the cache key string.
   */
  public static getEmbedCheckKey(url: string) {
    return `embed:${url}`;
  }

  /**
   * Gets key for caching a user's accessible collection IDs.
   *
   * @param userId The user ID to generate a key for.
   * @returns the cache key string.
   */
  public static getUserCollectionIdsKey(userId: string) {
    return `uc:${userId}`;
  }

  /**
   * Gets key for caching the document IDs a user is a member of.
   *
   * @param userId The user ID to generate a key for.
   * @returns the cache key string.
   */
  public static getUserMembershipDocumentIdsKey(userId: string) {
    return `ud:${userId}`;
  }

  /**
   * Gets key for caching a team's enabled webhook subscriptions.
   *
   * @param teamId The team ID to generate a key for.
   * @returns the cache key string.
   */
  public static getWebhookSubscriptionsKey(teamId: string) {
    return `whs:${teamId}`;
  }

  /**
   * Gets key for caching the count of a relationship managed by the
   * `CounterCache` decorator.
   *
   * @param modelName The owning model name (e.g. "Group").
   * @param relationName The relationship reference name (e.g. "members").
   * @param id The owning record id.
   * @returns the cache key string.
   */
  public static getCounterCacheKey(
    modelName: string,
    relationName: string,
    id: string
  ) {
    return `count:${modelName}:${relationName}:${id}`;
  }

  /**
   * Gets key for storing an auth provider's token used as a logout hint during
   * provider-initiated logout, referenced by a short session identifier.
   *
   * @param provider The auth provider id (e.g. "oidc").
   * @param sessionId The logout session identifier to generate a key for.
   * @returns the cache key string.
   */
  public static getLogoutTokenKey(provider: string, sessionId: string) {
    return `auth:logout:${provider}:${sessionId}`;
  }
}
