import { addSeconds } from "date-fns";
import Router from "koa-router";
import { Op, type Transaction } from "sequelize";
import { IntegrationService, IntegrationType } from "@shared/types";
import { toError } from "@shared/utils/error";
import { createContext } from "@server/context";
import { ValidationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import apexAuthRedirect from "@server/middlewares/apexAuthRedirect";
import auth from "@server/middlewares/authentication";
import validate from "@server/middlewares/validate";
import validateWebhook from "@server/middlewares/validateWebhook";
import { IntegrationAuthentication, Integration } from "@server/models";
import type { User } from "@server/models";
import { can } from "@server/policies";
import CacheIssueSourcesTask from "@server/queues/tasks/CacheIssueSourcesTask";
import { sequelize } from "@server/storage/database";
import { LockHelper } from "@server/storage/LockHelper";
import type { APIContext } from "@server/types";
import { CacheHelper } from "@server/utils/CacheHelper";
import { verifyOAuthStateNonce } from "@server/utils/oauth";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import { GitHubOAuthNonceCookie, GitHubUtils } from "../../shared/GitHubUtils";
import env from "../env";
import { GitHub, type UserInstallation } from "../github";
import GitHubWebhookTask from "../tasks/GitHubWebhookTask";
import * as T from "./schema";

const router = new Router();

// Completes both the installation of the app, which an admin does for the
// workspace and which records the installation as a workspace integration,
// and the authorization of a member's own account. Either way the code is
// exchanged for a token of the user's own account, which is stored as their
// linked account and is the only token ever used to unfurl.
router.get(
  "github.callback",
  auth({ optional: true }),
  validate(T.GitHubCallbackSchema),
  apexAuthRedirect<T.GitHubCallbackReq>({
    getTeamId: (ctx) => GitHubUtils.parseState(ctx.input.query.state)?.teamId,
    getRedirectPath: (ctx, team) =>
      GitHubUtils.callbackUrl({
        baseUrl: team.url,
        params: ctx.request.querystring,
      }),
    getErrorPath: () => GitHubUtils.errorUrl("unauthenticated"),
  }),
  async (ctx: APIContext<T.GitHubCallbackReq>) => {
    const {
      code,
      state,
      error,
      installation_id: installationId,
      setup_action: setupAction,
    } = ctx.input.query;
    const { user } = ctx.state.auth;

    if (error) {
      ctx.redirect(GitHubUtils.errorUrl(error));
      return;
    }

    if (setupAction === T.SetupAction.request) {
      ctx.redirect(GitHubUtils.installRequestUrl());
      return;
    }

    const parsedState = GitHubUtils.parseState(state);
    if (!parsedState) {
      throw ValidationError("Invalid state");
    }

    verifyOAuthStateNonce(ctx, GitHubOAuthNonceCookie, parsedState.nonce);

    // The validation middleware ensures that one of code and error is present.
    if (!code) {
      throw ValidationError("code is required");
    }

    // Only an admin can add an installation of the app to the workspace. The
    // installation is complete in GitHub by now, an admin records it by
    // installing again from the settings, which GitHub answers with the
    // existing installation.
    if (installationId && !can(user, "createIntegration", user.team)) {
      ctx.redirect(GitHubUtils.errorUrl("install_forbidden"));
      return;
    }

    // The token is issued before anything is stored, so one that is not kept
    // in the end is revoked below, GitHub would otherwise keep it valid until
    // it expires.
    let oauth: Awaited<ReturnType<typeof GitHub.oauthAccess>> | undefined;
    // Whether the link was committed, so that a failure after the commit, in
    // a hook that runs then, does not revoke the token that is kept.
    let committed = false;
    let isDuplicate = false;
    try {
      oauth = await GitHub.oauthAccess(code);
      const [account, installations] = await Promise.all([
        GitHub.getCurrentUser(oauth.access_token),
        installationId
          ? GitHub.getUserInstallations(oauth.access_token)
          : undefined,
      ]);

      // The installation must be one the user has access to in GitHub.
      const installation = installations?.find(
        (candidate) => candidate.id === installationId
      );
      if (installationId && !installation) {
        await GitHub.discardToken(oauth.access_token);
        ctx.redirect(GitHubUtils.errorUrl("unauthenticated"));
        return;
      }

      // An app that does not expire tokens issues neither a refresh token nor
      // an expiry, which then replace those of an earlier link rather than
      // being left in place.
      const tokens = {
        token: oauth.access_token,
        refreshToken: oauth.refresh_token ?? null,
        expiresAt: oauth.expires_in
          ? addSeconds(Date.now(), oauth.expires_in)
          : null,
      };
      const settings = {
        github: {
          account: {
            id: account.id,
            name: account.login,
            avatarUrl: account.avatarUrl,
          },
        },
      };

      // The transaction is managed here rather than by the transaction
      // middleware, so that a failure part way through the writes is rolled
      // back before it is reported below instead of being committed.
      await sequelize.transaction(async (transaction) => {
        // Registered first, so that it runs before the hooks the writes below
        // add, which may fail after the commit.
        transaction.afterCommit(() => {
          committed = true;
        });

        // Two callbacks of the same user completing at once would both find
        // no existing account and link twice, and two users completing with
        // the same GitHub account at once would both pass the duplicate check
        // below, so callbacks are serialized per workspace.
        await LockHelper.acquire(
          sequelize,
          `github.link:${user.teamId}`,
          transaction
        );

        // The installation is complete in GitHub, so it is recorded even when
        // the admin's own account cannot be linked below.
        if (installation) {
          await recordInstallation(user, installation, transaction);
        }

        // A GitHub account can only be linked by one user in the workspace.
        const linkedByOther = await Integration.count({
          where: {
            service: IntegrationService.GitHub,
            type: IntegrationType.LinkedAccount,
            teamId: user.teamId,
            userId: { [Op.ne]: user.id },
            "settings.github.account.id": account.id,
          },
          transaction,
        });
        isDuplicate = linkedByOther > 0;

        // A token that is not kept, the one replaced by linking again or the
        // one just issued for an account that is refused as a duplicate, is
        // revoked below, GitHub would otherwise keep it valid until it
        // expires.
        let staleToken: string | undefined = isDuplicate
          ? tokens.token
          : undefined;

        if (!isDuplicate) {
          // Only ever update the user's own linked account, never another
          // user's. An account whose authentication is missing is replaced.
          const [existing] = await GitHub.findLinkedAccounts(
            { teamId: user.teamId, userId: user.id },
            { transaction }
          );

          if (existing?.authentication) {
            if (existing.authentication.token !== tokens.token) {
              staleToken = existing.authentication.token;
            }
            // The integration row is written before the authentication row,
            // the order in which removing an account locks them, so that a
            // removal running at the same time cannot deadlock with this.
            existing.settings = settings;
            await existing.save({ transaction });
            await existing.authentication.update(tokens, { transaction });
          } else {
            if (existing) {
              await GitHub.destroyLinkedAccounts([existing], { transaction });
            }

            const authentication = await IntegrationAuthentication.create(
              {
                service: IntegrationService.GitHub,
                userId: user.id,
                teamId: user.teamId,
                ...tokens,
              },
              { transaction }
            );

            await Integration.createWithCtx<
              Integration<IntegrationType.LinkedAccount>
            >(createContext({ user, transaction }), {
              service: IntegrationService.GitHub,
              type: IntegrationType.LinkedAccount,
              userId: user.id,
              teamId: user.teamId,
              authenticationId: authentication.id,
              settings,
            });
          }
        }

        // The user's cached unfurls, including failures to unfurl without an
        // account, are stale now, as are those of every member once an
        // installation is added or updated, as the repositories the app can
        // reach may have changed. A newly created integration also clears
        // them when its event is processed, but that runs asynchronously and
        // may be later than the first request after the redirect.
        transaction.afterCommit(async () => {
          try {
            await CacheHelper.clearData(
              RedisPrefixHelper.getUnfurlPrefix(
                user.teamId,
                installation ? undefined : user.id
              )
            );
          } catch (err) {
            // The account is linked, and the stale entries expire on their
            // own, so this is not worth reporting the link as failed.
            Logger.warn(
              "Failed to clear cached unfurls after linking a GitHub account",
              toError(err)
            );
          }
          if (staleToken) {
            // The revocation is not awaited, the commit waits for its hooks
            // and so the redirect would wait for GitHub.
            void GitHub.discardToken(staleToken);
          }
        });
      });

      ctx.redirect(
        isDuplicate
          ? GitHubUtils.errorUrl("duplicate_account")
          : GitHubUtils.url
      );
    } catch (err) {
      Logger.error(
        "Encountered error during GitHub OAuth callback",
        toError(err)
      );
      // The writes were committed and only a hook that runs after the commit
      // failed, such as the scheduling of the event of the new account, so
      // the link is complete and its token is kept.
      if (committed) {
        ctx.redirect(
          isDuplicate
            ? GitHubUtils.errorUrl("duplicate_account")
            : GitHubUtils.url
        );
        return;
      }
      // The link was not completed, so the token is not kept either.
      if (oauth) {
        await GitHub.discardToken(oauth.access_token);
      }
      ctx.redirect(GitHubUtils.errorUrl("unauthenticated"));
    }
  }
);

/**
 * Records an installation of the app as a workspace integration, or updates
 * the integration that already records it, for example when the admin changed
 * the repositories the app can reach or accepted new permissions. The
 * repositories are fetched again once the update commits, as they are for a
 * new integration when its event is processed, so that installing again from
 * the settings also brings them up to date when the webhooks of GitHub did not.
 *
 * @param user the admin completing the installation.
 * @param installation the installation as GitHub describes it.
 * @param transaction the transaction to write within.
 */
async function recordInstallation(
  user: User,
  installation: UserInstallation,
  transaction: Transaction
): Promise<void> {
  // The app is installed on a user or organization, which has a login, or on
  // an enterprise, which has a slug instead.
  const account = installation.account;
  const github = {
    installation: {
      id: installation.id,
      account: {
        id: account?.id ?? installation.target_id,
        name: account
          ? "login" in account
            ? account.login
            : account.slug
          : String(installation.target_id),
        avatarUrl: account?.avatar_url ?? "",
      },
    },
  };

  // The permissions of the installation are recorded as scopes, the
  // authentication never holds a token.
  const scopes = Object.entries(installation.permissions).map(
    ([name, permission]) => `${name}:${String(permission)}`
  );

  const existing = await GitHub.findWorkspaceIntegrationByInstallation(
    user.teamId,
    installation.id,
    { transaction }
  );
  if (existing) {
    await existing.update(
      { settings: { ...existing.settings, github } },
      { transaction }
    );
    if (existing.authenticationId) {
      await IntegrationAuthentication.update(
        { scopes },
        { where: { id: existing.authenticationId }, transaction }
      );
    }
    transaction.afterCommit(async () => {
      await new CacheIssueSourcesTask().schedule({
        integrationId: existing.id,
      });
    });
    return;
  }

  const authentication = await IntegrationAuthentication.create(
    {
      service: IntegrationService.GitHub,
      userId: user.id,
      teamId: user.teamId,
      scopes,
    },
    { transaction }
  );
  await Integration.createWithCtx(createContext({ user, transaction }), {
    service: IntegrationService.GitHub,
    type: IntegrationType.Embed,
    userId: user.id,
    teamId: user.teamId,
    authenticationId: authentication.id,
    settings: { github },
  });
}

router.post(
  "github.webhooks",
  validateWebhook({
    secretKey: env.GITHUB_WEBHOOK_SECRET!,
    getSignatureFromHeader: (ctx) => {
      const { headers } = ctx.request;
      const signatureHeader = headers["x-hub-signature-256"];
      const signature = Array.isArray(signatureHeader)
        ? signatureHeader[0]
        : signatureHeader;
      return signature?.split("=")[1];
    },
  }),
  async (ctx: APIContext) => {
    const { headers, body } = ctx.request;

    await new GitHubWebhookTask().schedule({
      payload: body,
      headers,
    });

    ctx.status = 202;
  }
);

export default router;
