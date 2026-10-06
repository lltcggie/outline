import type { IssueSource } from "@shared/schema";
import { IntegrationService, IntegrationType } from "@shared/types";
import Logger from "@server/logging/Logger";
import { Integration } from "@server/models";
import { BaseIssueProvider } from "@server/utils/BaseIssueProvider";
import { CacheHelper } from "@server/utils/CacheHelper";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import { GitLabUtils } from "../shared/GitLabUtils";
import { sequelize } from "@server/storage/database";
import { GitLab } from "./gitlab";

interface GitLabWebhookPayload {
  event_name?: string;
  user_id?: string;
}

export class GitLabIssueProvider extends BaseIssueProvider {
  constructor() {
    super(IntegrationService.GitLab);
  }

  /**
   * Workspace integrations only hold the OAuth application and each member
   * links their own account, so there is no token that could list projects for
   * the whole workspace. A token left behind by a legacy connection is never
   * used, so no sources are returned.
   *
   * @param _integration the workspace integration.
   * @returns an empty list.
   */
  async fetchSources(
    _integration: Integration<IntegrationType.Embed>
  ): Promise<IssueSource[]> {
    return [];
  }

  async handleWebhook({
    payload,
    headers,
    teamId,
  }: {
    payload: Record<string, unknown>;
    headers: Record<string, unknown>;
    teamId: string | null | undefined;
  }) {
    const hookId = headers["x-gitlab-webhook-uuid"] as string;
    const typedPayload = payload as GitLabWebhookPayload;
    const eventName = typedPayload.event_name;

    if (!eventName) {
      Logger.warn(
        `Received GitLab webhook without event name; hookId: ${hookId}, eventName: ${eventName}`
      );
      return;
    }

    if (teamId === undefined) {
      Logger.warn(`Received GitLab webhook without authorization scope`);
      return;
    }

    // Issue sources are not kept for GitLab, see fetchSources, so only the
    // removal of users matters.
    if (eventName === "user_destroy") {
      await this.destroyLinkedAccounts(typedPayload, headers, teamId);
    }
  }

  /**
   * Removes the accounts linked to a GitLab user that was deleted, together
   * with their tokens. Workspace integrations are never removed here.
   *
   * @param payload the webhook payload.
   * @param headers the webhook request headers.
   * @param teamId the team the webhook is scoped to, all teams when null.
   */
  private async destroyLinkedAccounts(
    payload: GitLabWebhookPayload,
    headers: Record<string, unknown>,
    teamId: string | null
  ) {
    const gitlabUserId = Number(payload.user_id);
    const instanceUrl = GitLab.getHeader(headers, "x-gitlab-instance");

    // Account ids are only unique within an instance.
    if (!gitlabUserId || !instanceUrl) {
      Logger.warn(`GitLab user_destroy event without user_id or instance`);
      return;
    }

    await sequelize.transaction(async (transaction) => {
      const linkedAccounts = (
        (await Integration.findAll({
          where: {
            service: IntegrationService.GitLab,
            type: IntegrationType.LinkedAccount,
            ...(teamId ? { teamId } : {}),
            "settings.gitlab.account.id": gitlabUserId,
          },
          lock: transaction.LOCK.UPDATE,
          transaction,
        })) as Integration<IntegrationType.LinkedAccount>[]
      ).filter((integration) =>
        GitLabUtils.isSameInstance(
          integration.settings?.gitlab?.url,
          instanceUrl
        )
      );

      await GitLab.destroyLinkedAccounts(linkedAccounts, { transaction });

      transaction.afterCommit(async () => {
        await Promise.all(
          linkedAccounts.map((linkedAccount) =>
            CacheHelper.clearData(
              RedisPrefixHelper.getUnfurlPrefix(
                linkedAccount.teamId,
                linkedAccount.userId
              )
            )
          )
        );
      });
    });
  }
}
