import Router from "koa-router";
import { Op } from "sequelize";
import { toError } from "@shared/utils/error";
import { IntegrationService, IntegrationType } from "@shared/types";
import { createContext } from "@server/context";
import { NotFoundError, ValidationError } from "@server/errors";
import apexAuthRedirect from "@server/middlewares/apexAuthRedirect";
import auth from "@server/middlewares/authentication";
import { transaction } from "@server/middlewares/transaction";
import validate from "@server/middlewares/validate";
import validateWebhook from "@server/middlewares/validateWebhook";
import { IntegrationAuthentication, Integration } from "@server/models";
import { authorize, can } from "@server/policies";
import type { APIContext } from "@server/types";
import { CacheHelper } from "@server/utils/CacheHelper";
import { safeEqual } from "@server/utils/crypto";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import {
  generateOAuthStateNonce,
  verifyOAuthStateNonce,
} from "@server/utils/oauth";
import { validateUrlNotPrivate } from "@server/utils/url";
import { addSeconds } from "date-fns";
import Logger from "@server/logging/Logger";
import { GitLabOAuthNonceCookie, GitLabUtils } from "../../shared/GitLabUtils";
import { GitLab } from "../gitlab";
import env from "../env";
import GitLabWebhookTask from "../tasks/GitLabWebhookTask";
import * as T from "./schema";

const router = new Router();

function getGitLabWebhookToken(ctx: APIContext): string | undefined {
  return GitLab.getHeader(ctx.request.headers, "x-gitlab-token");
}

// Configures the GitLab instance and OAuth application for the workspace, and
// then links the admin's own account. The workspace integration never holds a
// token, previews are always fetched with each user's own linked account.
router.post(
  "gitlab.connect",
  auth(),
  validate(T.GitLabConnectSchema),
  transaction(),
  async (ctx: APIContext<T.GitLabConnectReq>) => {
    const { url: rawUrl, clientId, clientSecret } = ctx.input.body;
    // Normalized so that the instance is matched however its URL is written.
    const url = rawUrl ? GitLabUtils.normalizeInstanceUrl(rawUrl) : undefined;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    authorize(user, "createIntegration", user.team);

    if (url) {
      await validateUrlNotPrivate(url);
    } else if (!env.GITLAB_CLIENT_ID) {
      throw ValidationError("GitLab Cloud credentials are not configured");
    }

    // An instance that is still being connected is configured again.
    let integration = (
      await GitLab.findWorkspaceIntegrations(user.teamId, { transaction })
    ).find((candidate) =>
      GitLabUtils.isSameInstance(candidate.settings?.gitlab?.url, url)
    );

    // A URL stored by an earlier version may be written differently, which
    // would prevent webhooks of the instance from being matched. A new
    // integration, or one whose OAuth application is replaced, stays pending,
    // hidden from members and not used for unfurling, until the admin has
    // completed authorization with it.
    // The account details stored by a previous version that connected the
    // workspace with a single account are dropped, as is its token below.
    const { installation: _installation, ...storedGitlab } =
      integration?.settings?.gitlab ?? {};
    const gitlab = {
      ...storedGitlab,
      ...(url ? { url } : {}),
      ...(integration ? {} : { pending: true }),
    };
    let authenticationId = integration?.authenticationId;

    if (
      integration?.authentication &&
      (integration.authentication.token ||
        integration.authentication.refreshToken)
    ) {
      // Drop any token stored by a previous version, it is never used to
      // unfurl. This also covers GitLab Cloud, which has no credentials below.
      integration.authentication.setDataValue("token", null as never);
      integration.authentication.setDataValue("refreshToken", null as never);
      integration.authentication.setDataValue("expiresAt", null as never);
      await integration.authentication.save({ transaction });
    }

    if (url && clientId && clientSecret) {
      // Tokens are issued for an OAuth application, so accounts linked through
      // a different application can no longer be refreshed, unless another
      // integration of the instance still has that application, see
      // GitLab.releaseLinkedAccounts.
      if (integration && integration.authentication?.clientId !== clientId) {
        await GitLab.releaseLinkedAccounts(
          integration,
          integration.authentication?.clientId,
          { transaction }
        );
        gitlab.pending = true;
        transaction.afterCommit(async () => {
          await CacheHelper.clearData(
            RedisPrefixHelper.getUnfurlPrefix(user.teamId)
          );
        });
      }

      if (integration?.authentication) {
        // Replace the credentials of the OAuth application.
        integration.authentication.clientId = clientId;
        integration.authentication.clientSecret = clientSecret;
        await integration.authentication.save({ transaction });
      } else {
        const authentication = await IntegrationAuthentication.create(
          {
            service: IntegrationService.GitLab,
            userId: user.id,
            teamId: user.teamId,
            clientId,
            clientSecret,
          },
          { transaction }
        );
        authenticationId = authentication.id;
      }
    }

    if (integration) {
      // Nothing is written when neither has changed.
      await integration.update(
        { authenticationId, settings: { ...integration.settings, gitlab } },
        { transaction }
      );
    } else {
      integration = (await Integration.createWithCtx(ctx, {
        service: IntegrationService.GitLab,
        type: IntegrationType.Embed,
        userId: user.id,
        teamId: user.teamId,
        authenticationId,
        settings: { gitlab },
      })) as Integration<IntegrationType.Embed>;
    }

    const nonce = generateOAuthStateNonce(ctx, GitLabOAuthNonceCookie);
    const redirectUrl = GitLabUtils.authUrl(
      { teamId: user.teamId, nonce, integrationId: integration.id },
      url,
      clientId
    );
    ctx.body = {
      data: { redirectUrl },
    };
  }
);

// Starts linking the user's own GitLab account through the OAuth application
// of a workspace integration. Available to every member of the workspace.
router.post(
  "gitlab.authorize",
  auth(),
  validate(T.GitLabAuthorizeSchema),
  async (ctx: APIContext<T.GitLabAuthorizeReq>) => {
    const { integrationId } = ctx.input.body;
    const { user } = ctx.state.auth;

    const integration = await GitLab.findWorkspaceIntegrationById(
      user.teamId,
      integrationId
    );

    if (!integration) {
      throw NotFoundError("GitLab integration not found");
    }
    authorize(user, "read", integration);

    // Only an admin can complete connecting an instance, members link their
    // accounts once it works.
    if (integration.settings?.gitlab?.pending) {
      authorize(user, "createIntegration", user.team);
    }

    const url = integration.settings?.gitlab?.url;
    const clientId = integration.authentication?.clientId ?? undefined;
    if (url ? !clientId : !env.GITLAB_CLIENT_ID) {
      throw ValidationError("GitLab integration is not configured");
    }

    const nonce = generateOAuthStateNonce(ctx, GitLabOAuthNonceCookie);
    const redirectUrl = GitLabUtils.authUrl(
      { teamId: user.teamId, nonce, integrationId: integration.id },
      url,
      clientId
    );
    ctx.body = {
      data: { redirectUrl },
    };
  }
);

router.get(
  "gitlab.callback",
  auth({ optional: true }),
  validate(T.GitLabCallbackSchema),
  apexAuthRedirect<T.GitLabCallbackReq>({
    getTeamId: (ctx) => GitLabUtils.parseState(ctx.input.query.state)?.teamId,
    getRedirectPath: (ctx, team) =>
      GitLabUtils.callbackUrl({
        baseUrl: team.url,
        params: ctx.request.querystring,
      }),
    getErrorPath: () => GitLabUtils.errorUrl("unauthenticated"),
  }),
  transaction(),
  async (ctx: APIContext<T.GitLabCallbackReq>) => {
    const { code, error, state } = ctx.input.query;
    const { user } = ctx.state.auth;
    const { transaction } = ctx.state;

    if (error) {
      ctx.redirect(GitLabUtils.errorUrl(error));
      return;
    }

    const parsedState = GitLabUtils.parseState(state);
    if (!parsedState) {
      throw ValidationError("Invalid state");
    }

    verifyOAuthStateNonce(ctx, GitLabOAuthNonceCookie, parsedState.nonce);

    try {
      const workspaceIntegration = parsedState.integrationId
        ? await GitLab.findWorkspaceIntegrationById(
            user.teamId,
            parsedState.integrationId,
            { transaction }
          )
        : null;

      // Only an admin can complete connecting an instance.
      const isPending = !!workspaceIntegration?.settings?.gitlab?.pending;
      if (
        !workspaceIntegration ||
        (isPending && !can(user, "createIntegration", user.team))
      ) {
        ctx.redirect(GitLabUtils.errorUrl("unauthenticated"));
        return;
      }

      const customUrl = workspaceIntegration.settings?.gitlab?.url;
      const appAuthentication = workspaceIntegration.authentication;

      const oauth = await GitLab.oauthAccess({
        code,
        customUrl,
        clientId: appAuthentication?.clientId ?? undefined,
        clientSecret: appAuthentication?.clientSecret ?? undefined,
      });

      const userInfo = await GitLab.getCurrentUser({
        accessToken: oauth.access_token,
        customUrl,
      });

      const linkedAccounts = await GitLab.findLinkedAccounts(
        { teamId: user.teamId, customUrl },
        { transaction }
      );

      // A GitLab account can only be linked by one user in the workspace.
      if (
        linkedAccounts.some(
          (integration) =>
            integration.userId !== user.id &&
            integration.settings?.gitlab?.account.id === userInfo.id
        )
      ) {
        ctx.redirect(GitLabUtils.errorUrl("duplicate_account"));
        return;
      }

      const tokens = {
        token: oauth.access_token,
        refreshToken: oauth.refresh_token,
        expiresAt: oauth.expires_in
          ? addSeconds(Date.now(), oauth.expires_in)
          : undefined,
        scopes: oauth.scope.split(" "),
      };
      const settings = {
        gitlab: {
          ...(customUrl ? { url: customUrl } : {}),
          // The token can only be refreshed with this integration's OAuth
          // application, even if the instance is configured more than once.
          integrationId: workspaceIntegration.id,
          account: {
            id: userInfo.id,
            name: userInfo.username,
            avatarUrl: userInfo.avatar_url,
          },
        },
      };

      // Only ever update the user's own linked account, never another user's.
      const existing = linkedAccounts.find(
        (integration) => integration.userId === user.id
      );

      if (existing?.authentication) {
        await existing.authentication.update(tokens, { transaction });
        existing.settings = settings;
        await existing.save({ transaction });
      } else {
        if (existing) {
          await GitLab.destroyLinkedAccounts([existing], { transaction });
        }

        const authentication = await IntegrationAuthentication.create(
          {
            service: IntegrationService.GitLab,
            userId: user.id,
            teamId: user.teamId,
            ...tokens,
          },
          { transaction }
        );

        await Integration.createWithCtx(createContext({ user, transaction }), {
          service: IntegrationService.GitLab,
          type: IntegrationType.LinkedAccount,
          userId: user.id,
          teamId: user.teamId,
          authenticationId: authentication.id,
          settings,
        });
      }

      // Authorization succeeded with the OAuth application, so the instance is
      // connected and its links are unfurled for members from now on.
      if (isPending) {
        const { pending: _pending, ...gitlab } =
          workspaceIntegration.settings?.gitlab ?? {};
        await workspaceIntegration.update(
          { settings: { ...workspaceIntegration.settings, gitlab } },
          { transaction }
        );
      }

      // The user's cached unfurls, including failures to unfurl without an
      // account, are stale now, as are those of every member once the
      // instance is connected. A newly created account also clears the user's
      // when its event is processed, but that runs asynchronously and may be
      // later than the first request after the redirect.
      transaction.afterCommit(async () => {
        await CacheHelper.clearData(
          RedisPrefixHelper.getUnfurlPrefix(
            user.teamId,
            isPending ? undefined : user.id
          )
        );
      });

      ctx.redirect(GitLabUtils.url);
    } catch (err) {
      Logger.error(
        "Encountered error during Gitlab OAuth callback",
        toError(err)
      );
      ctx.redirect(GitLabUtils.errorUrl("unauthenticated"));
    }
  }
);

router.post(
  "gitlab.webhooks",
  validateWebhook({
    hmacSign: false,
    secretKey: async (ctx) => {
      const instanceUrl = GitLab.getHeader(
        ctx.request.headers,
        "x-gitlab-instance"
      )?.replace(/\/+$/, "");

      // Self-hosted instances store their client secret in the database,
      // use the X-Gitlab-Instance header to find the matching integration.
      if (instanceUrl && instanceUrl !== "https://gitlab.com") {
        const integrations = await Integration.findAll({
          where: {
            service: IntegrationService.GitLab,
            type: IntegrationType.Embed,
            // URLs are normalized when connecting, those stored by an earlier
            // version are kept as entered.
            "settings.gitlab.url": {
              [Op.in]: [
                ...new Set([
                  instanceUrl,
                  GitLabUtils.normalizeInstanceUrl(instanceUrl),
                ]),
              ],
            },
          },
          include: [
            {
              model: IntegrationAuthentication,
              as: "authentication",
              required: true,
            },
          ],
        });
        const token = getGitLabWebhookToken(ctx);
        const teamIds = new Set<string>();
        let clientSecret: string | undefined;

        for (const integration of integrations) {
          const candidateSecret = integration.authentication.clientSecret;

          if (!candidateSecret || !safeEqual(candidateSecret, token)) {
            continue;
          }

          clientSecret = candidateSecret;
          teamIds.add(integration.teamId);
        }

        if (clientSecret) {
          ctx.state.webhookTeamIds = [...teamIds];
        }

        return clientSecret;
      }

      // Default GitLab.com instance uses the env secret
      return env.GITLAB_CLIENT_SECRET;
    },
    getSignatureFromHeader: getGitLabWebhookToken,
  }),
  async (ctx: APIContext) => {
    const { headers, body } = ctx.request;
    const teamIds: Array<string | null> = ctx.state.webhookTeamIds ?? [null];

    await Promise.all(
      teamIds.map((teamId) =>
        new GitLabWebhookTask().schedule({
          payload: body,
          headers,
          teamId,
        })
      )
    );

    ctx.status = 202;
  }
);

export default router;
