import { addSeconds } from "date-fns";
import Router from "koa-router";
import { IntegrationService, IntegrationType } from "@shared/types";
import { toError } from "@shared/utils/error";
import { createContext } from "@server/context";
import { ValidationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import apexAuthRedirect from "@server/middlewares/apexAuthRedirect";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import { Integration, IntegrationAuthentication } from "@server/models";
import { sequelize } from "@server/storage/database";
import { LockHelper } from "@server/storage/LockHelper";
import type { APIContext } from "@server/types";
import { CacheHelper } from "@server/utils/CacheHelper";
import {
  generateOAuthStateNonce,
  verifyOAuthStateNonce,
} from "@server/utils/oauth";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import { AsanaOAuthNonceCookie, AsanaUtils } from "../../shared/AsanaUtils";
import { Asana } from "../asana";
import env from "../env";
import * as T from "./schema";

const router = new Router();

// Starts linking the user's own Asana account. Available to every member of
// the workspace, previews are always fetched with each user's own account.
router.post("asana.authorize", auth(), async (ctx: APIContext) => {
  const { user } = ctx.state.auth;

  // The router is only registered when the application is configured, this
  // narrows the type of the client id.
  if (!env.ASANA_CLIENT_ID) {
    throw ValidationError("Asana integration is not configured");
  }

  const nonce = generateOAuthStateNonce(ctx, AsanaOAuthNonceCookie);
  const redirectUrl = AsanaUtils.authUrl(
    { teamId: user.teamId, nonce },
    env.ASANA_CLIENT_ID,
    env.ASANA_OAUTH_SCOPES
  );
  ctx.body = {
    data: { redirectUrl },
  };
});

router.get(
  "asana.callback",
  auth({ optional: true }),
  validate(T.AsanaCallbackSchema),
  apexAuthRedirect<T.AsanaCallbackReq>({
    getTeamId: (ctx) => AsanaUtils.parseState(ctx.input.query.state)?.teamId,
    getRedirectPath: (ctx, team) =>
      AsanaUtils.callbackUrl({
        baseUrl: team.url,
        params: ctx.request.querystring,
      }),
    getErrorPath: () => AsanaUtils.errorUrl("unauthenticated"),
  }),
  async (ctx: APIContext<T.AsanaCallbackReq>) => {
    const { code, error, state } = ctx.input.query;
    const { user } = ctx.state.auth;

    // Check error after any sub-domain redirection, otherwise the user would
    // be redirected to the root domain.
    if (error) {
      ctx.redirect(AsanaUtils.errorUrl(error));
      return;
    }
    // The validation middleware ensures that one of code and error is present.
    if (!code) {
      throw ValidationError("code is required");
    }

    const parsedState = AsanaUtils.parseState(state);
    if (!parsedState) {
      throw ValidationError("Invalid state");
    }

    verifyOAuthStateNonce(ctx, AsanaOAuthNonceCookie, parsedState.nonce);

    try {
      const oauth = await Asana.oauthAccess(code);
      const account = await Asana.getCurrentUser(oauth.access_token);

      const tokens = {
        token: oauth.access_token,
        refreshToken: oauth.refresh_token,
        expiresAt: addSeconds(Date.now(), oauth.expires_in),
        scopes: env.ASANA_OAUTH_SCOPES.split(" "),
      };
      const settings = {
        asana: {
          account: {
            id: account.gid,
            name: account.name,
            email: account.email ?? undefined,
            avatarUrl: account.photo?.image_128x128,
          },
        },
      };

      // The transaction is managed here rather than by the transaction
      // middleware, so that a failure part way through the writes is rolled
      // back before it is reported below instead of being committed.
      await sequelize.transaction(async (transaction) => {
        // Two callbacks of the same user completing at once would both find
        // no existing account and link twice, so they are serialized per
        // user.
        await LockHelper.acquire(
          sequelize,
          `asana.link:${user.teamId}:${user.id}`,
          transaction
        );

        // Only ever update the user's own linked account, never another
        // user's. An account whose authentication is missing is replaced.
        const existing = await Asana.findLinkedAccount(user, {
          transaction,
          requireAuthentication: false,
        });

        if (existing?.authentication) {
          await existing.authentication.update(tokens, { transaction });
          existing.settings = settings;
          await existing.save({ transaction });
        } else {
          if (existing) {
            await existing.destroy({ transaction, force: true });
          }

          const authentication = await IntegrationAuthentication.create(
            {
              service: IntegrationService.Asana,
              userId: user.id,
              teamId: user.teamId,
              ...tokens,
            },
            { transaction }
          );

          await Integration.createWithCtx<
            Integration<IntegrationType.LinkedAccount>
          >(createContext({ user, transaction }), {
            service: IntegrationService.Asana,
            type: IntegrationType.LinkedAccount,
            userId: user.id,
            teamId: user.teamId,
            authenticationId: authentication.id,
            settings,
          });
        }

        // The user's cached unfurls, including failures to unfurl without an
        // account, are stale now. A newly created account also clears them
        // when its event is processed, but that runs asynchronously and may
        // be later than the first request after the redirect.
        transaction.afterCommit(async () => {
          await CacheHelper.clearData(
            RedisPrefixHelper.getUnfurlPrefix(user.teamId, user.id)
          );
        });
      });

      ctx.redirect(AsanaUtils.url);
    } catch (err) {
      Logger.error(
        "Encountered error during Asana OAuth callback",
        toError(err)
      );
      ctx.redirect(AsanaUtils.errorUrl("unknown"));
    }
  }
);

export default router;
