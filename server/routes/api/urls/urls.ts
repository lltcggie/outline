import dns from "node:dns";
import Router from "@koa/router";
import { traceFunction } from "@server/logging/tracing";
import isUUID from "validator/lib/isUUID";
import { MentionType, UnfurlResourceType } from "@shared/types";
import { parseDomain } from "@shared/utils/domains";
import parseDocumentSlug from "@shared/utils/parseDocumentSlug";
import parseMentionUrl from "@shared/utils/parseMentionUrl";
import { isInternalUrl, parseShareIdFromUrl } from "@shared/utils/urls";
import {
  AuthenticationError,
  NotFoundError,
  ValidationError,
} from "@server/errors";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { Document, Share, Team, User, Group, GroupUser } from "@server/models";
import { authorize, can } from "@server/policies";
import { loadPublicShare } from "@server/commands/shareLoader";
import presentUnfurl from "@server/presenters/unfurl";
import type { APIContext, Unfurl } from "@server/types";
import { CacheHelper, type CacheResult } from "@server/utils/CacheHelper";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import { Hook, PluginManager } from "@server/utils/PluginManager";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import {
  checkEmbeddability,
  type EmbedCheckResult,
} from "@server/utils/embeds";
import { getTeamFromContext } from "@server/utils/passport";
import * as T from "./schema";
import { MAX_AVATAR_DISPLAY } from "@shared/constants";
import { Day, Minute } from "@shared/utils/time";

const router = new Router();
const plugins = PluginManager.getHooks(Hook.UnfurlProvider);
const userPlugins = plugins.filter(
  (plugin) => plugin.value.cacheScope !== "team"
);
const teamPlugins = plugins.filter(
  (plugin) => plugin.value.cacheScope === "team"
);

/**
 * Unfurls a url with the first of the given providers that recognizes it.
 *
 * @param providers the providers to try, in order.
 * @param url the url to unfurl.
 * @param actor the user unfurling the url.
 * @returns the result to cache, or undefined if no provider recognized it.
 */
async function unfurlWith(
  providers: typeof plugins,
  url: string,
  actor: User
): Promise<CacheResult<Unfurl | { error: true }> | undefined> {
  const hostname = new URL(url).hostname;

  for (const plugin of providers) {
    const pluginName = plugin.name ?? "unknown";
    const unfurl = await traceFunction({
      spanName: "unfurl.plugin",
      resourceName: pluginName,
      tags: {
        "unfurl.plugin": pluginName,
        "unfurl.url_host": hostname,
      },
    })(() => plugin.value.unfurl(url, actor))();
    if (unfurl) {
      if ("error" in unfurl) {
        return {
          data: { error: true as const },
          expiry:
            "cacheExpiry" in unfurl && typeof unfurl.cacheExpiry === "number"
              ? unfurl.cacheExpiry
              : Minute.seconds,
        };
      }
      return {
        data: unfurl as Unfurl,
        expiry: plugin.value.cacheExpiry,
      };
    }
  }
  return undefined;
}

router.post(
  "urls.unfurl",
  rateLimiter(RateLimiterStrategy.OneThousandPerHour),
  auth({ optional: true }),
  validate(T.UrlsUnfurlSchema),
  async (ctx: APIContext<T.UrlsUnfurlReq>) => {
    const { url, documentId } = ctx.input.body;
    const urlObj = new URL(url);

    // A url may point at this installation without matching the default env.URL
    // when the team is on a custom domain or hosted subdomain.
    const isTeamUrl =
      isInternalUrl(url) || !!ctx.state.auth.user?.team.isTeamUrl(url);

    // Public share URLs – does not require authentication
    if (isTeamUrl) {
      const shareId = parseShareIdFromUrl(url);

      if (shareId) {
        const actor = ctx.state.auth.user;
        // teamId is only passed for slugs, so shares of other teams can unfurl
        let teamId: string | undefined;
        if (!isUUID(shareId)) {
          teamId =
            actor?.teamId ??
            (await getTeamFromContext(ctx, { includeOAuthState: false }))?.id;
        }
        const previewDocumentId = parseDocumentSlug(url);
        const { share, document } = await loadPublicShare({
          id: shareId,
          documentId: previewDocumentId,
          teamId,
        });

        if (!document) {
          ctx.response.status = 204;
          return;
        }

        // The share page signs this document's attachments, so this adds no access.
        ctx.body = await presentUnfurl({
          type: UnfurlResourceType.Document,
          document,
          anchor: urlObj.hash,
          signedUrls: true,
          url: `${share.canonicalUrl}/doc/${document.url.replace("/doc/", "")}${urlObj.hash}`,
        });
        return;
      }
    }

    // Everything below requires authentication
    const { user: actor } = ctx.state.auth;
    if (!actor) {
      throw AuthenticationError();
    }

    // Mentions
    if (urlObj.protocol === "mention:") {
      if (!documentId) {
        throw ValidationError("Document ID is required to unfurl a mention");
      }
      const { modelId, mentionType } = parseMentionUrl(url);

      if (mentionType === MentionType.User) {
        const [user, document] = await Promise.all([
          User.findByPk(modelId),
          Document.findByPk(documentId, {
            userId: actor.id,
          }),
        ]);
        if (!user) {
          throw NotFoundError("Mentioned user does not exist");
        }
        if (!document) {
          throw NotFoundError("Document does not exist");
        }
        authorize(actor, "read", user);
        authorize(actor, "read", document);

        ctx.body = await presentUnfurl(
          {
            type: UnfurlResourceType.Mention,
            user,
            document,
          },
          {
            includeEmail: !!can(actor, "readEmail", user),
            includeLastViewed:
              document.insightsEnabled && !!can(actor, "listViews", document),
          }
        );
      } else if (mentionType === MentionType.Group) {
        const [group, document] = await Promise.all([
          Group.findByPk(modelId),
          Document.findByPk(documentId, {
            userId: actor.id,
          }),
        ]);
        if (!group) {
          throw NotFoundError("Mentioned group does not exist");
        }
        if (!document) {
          throw NotFoundError("Document does not exist");
        }
        authorize(actor, "read", group);
        authorize(actor, "read", document);

        // Get group members for display
        const groupUsers = await GroupUser.findAll({
          where: { groupId: group.id },
          include: [
            {
              model: User,
              as: "user",
            },
          ],
          limit: MAX_AVATAR_DISPLAY,
        });

        const users = groupUsers.map((gu) => gu.user).filter(Boolean);

        ctx.body = await presentUnfurl({
          type: UnfurlResourceType.Group,
          group,
          users,
        });
      }
      return;
    }

    // Internal resources
    if (isTeamUrl) {
      const previewDocumentId = parseDocumentSlug(url);
      if (previewDocumentId) {
        const document = await Document.findByPk(previewDocumentId, {
          userId: actor.id,
        });
        if (!document || !can(actor, "read", document)) {
          ctx.response.status = 204;
          return;
        }

        ctx.body = await presentUnfurl({
          type: UnfurlResourceType.Document,
          document,
          viewer: actor,
          anchor: urlObj.hash,
        });
        return;
      }

      ctx.response.status = 204;
      return;
    }

    // Guests are only shown what an account that they linked themselves can
    // access, other providers unfurl with credentials of the workspace.
    const userProviders = actor.isGuest
      ? userPlugins.filter((plugin) => plugin.value.userAccess)
      : userPlugins;
    if (actor.isGuest && !userProviders.length) {
      ctx.response.status = 204;
      return;
    }

    // Use getDataOrSet which handles distributed locking to prevent thundering herd
    // when multiple clients request the same URL simultaneously.
    const defaultCacheExpiry = 3600;

    // Providers that fetch with the user's own access are cached per user. When
    // none of them recognizes the url this is remembered, so that the shared
    // result is used without asking them again.
    const userResult = await CacheHelper.getDataOrSet<
      Unfurl | { error: true } | { unhandled: true }
    >(
      RedisPrefixHelper.getUnfurlKey(actor.teamId, actor.id, url),
      async () =>
        (await unfurlWith(userProviders, url, actor)) ?? {
          data: { unhandled: true as const },
          expiry: defaultCacheExpiry,
        },
      defaultCacheExpiry
    );

    // Other providers return the same result to everyone, so it is shared
    // within the team.
    const unfurlResult =
      userResult && "unhandled" in userResult
        ? actor.isGuest
          ? undefined
          : await CacheHelper.getDataOrSet<Unfurl | { error: true }>(
              RedisPrefixHelper.getUnfurlKey(actor.teamId, undefined, url),
              () => unfurlWith(teamPlugins, url, actor),
              defaultCacheExpiry
            )
        : userResult;

    if (!unfurlResult || "error" in unfurlResult) {
      ctx.response.status = 204;
      return;
    }

    ctx.body = await presentUnfurl(unfurlResult);
    return;
  }
);

router.post(
  "urls.checkEmbed",
  rateLimiter(RateLimiterStrategy.OneHundredPerHour),
  auth(),
  validate(T.UrlsCheckEmbedSchema),
  async (ctx: APIContext<T.UrlsCheckEmbedReq>) => {
    const { url } = ctx.input.body;

    const result = await CacheHelper.getDataOrSet<EmbedCheckResult>(
      RedisPrefixHelper.getEmbedCheckKey(url),
      () => checkEmbeddability(url),
      Day.seconds
    );

    ctx.body = result
      ? { embeddable: result.embeddable, reason: result.reason }
      : { embeddable: false, reason: "error" };
  }
);

router.post(
  "urls.validateCustomDomain",
  rateLimiter(RateLimiterStrategy.OneHundredPerHour),
  auth(),
  validate(T.UrlsCheckCnameSchema),
  async (ctx: APIContext<T.UrlsCheckCnameReq>) => {
    const { hostname } = ctx.input.body;

    const [team, share] = await Promise.all([
      Team.findByDomain(hostname),
      Share.findOne({
        where: {
          domain: hostname,
        },
      }),
    ]);
    if (team || share) {
      throw ValidationError("Domain is already in use");
    }

    let addresses;
    try {
      addresses = await new Promise<string[]>((resolve, reject) => {
        dns.resolveCname(hostname, (err, res) => {
          if (err) {
            return reject(err);
          }
          return resolve(res);
        });
      });
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOTFOUND") {
        throw NotFoundError("No CNAME record found");
      }

      throw ValidationError("Invalid domain");
    }

    const address = addresses[0];
    if (!address) {
      throw ValidationError("No CNAME record found");
    }

    // the record must point at the base domain, or a subdomain of it
    if (parseDomain(address).custom) {
      throw ValidationError("CNAME is not configured correctly");
    }

    ctx.body = {
      success: true,
    };
  }
);

export default router;
