import { IntegrationType } from "@shared/types";
import { Integration } from "@server/models";
import BaseProcessor from "@server/queues/processors/BaseProcessor";
import type { IntegrationEvent, Event } from "@server/types";
import { CacheHelper } from "@server/utils/CacheHelper";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import CacheIssueSourcesTask from "../tasks/CacheIssueSourcesTask";

export default class IntegrationCreatedProcessor extends BaseProcessor {
  static applicableEvents: Event["name"][] = ["integrations.create"];

  async perform(event: IntegrationEvent) {
    const integration = await Integration.findOne({
      where: {
        id: event.modelId,
      },
      paranoid: false,
    });
    if (!integration) {
      return;
    }

    // A newly linked account changes what the user can see, so their cached
    // unfurls, including failures, are stale now.
    if (integration.type === IntegrationType.LinkedAccount) {
      await CacheHelper.clearData(
        RedisPrefixHelper.getUnfurlPrefix(
          integration.teamId,
          integration.userId
        )
      );
      return;
    }

    if (integration.type !== IntegrationType.Embed) {
      return;
    }

    // Store the available issue sources in the integration record.
    await new CacheIssueSourcesTask().schedule({
      integrationId: integration.id,
    });

    // Clear the cache of unfurled data for the team as it may be stale now.
    await CacheHelper.clearData(
      RedisPrefixHelper.getUnfurlPrefix(integration.teamId)
    );
  }
}
