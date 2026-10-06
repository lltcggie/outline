import { sortBy } from "es-toolkit/compat";
import { computed, override } from "mobx";
import { computedFn } from "mobx-utils";
import { IntegrationService, IntegrationType } from "@shared/types";
import naturalSort from "@shared/utils/naturalSort";
import type RootStore from "~/stores/RootStore";
import Store from "~/stores/base/Store";
import Integration from "~/models/Integration";

class IntegrationsStore extends Store<Integration> {
  constructor(rootStore: RootStore) {
    super(rootStore, Integration);
  }

  findByService(service: string) {
    return this.orderedData.find(
      (integration) => integration.service === service
    );
  }

  /**
   * Returns the integrations for a service, ordered by name.
   *
   * @param service the service to return integrations for.
   * @returns the integrations for the service.
   */
  filterByService = computedFn(
    (service: IntegrationService): Integration<IntegrationType.Embed>[] =>
      this.orderedData.filter((integration) => integration.service === service),
    { requiresReaction: false }
  );

  @override
  get orderedData(): Integration[] {
    return naturalSort(Array.from(this.data.values()), "name");
  }

  /**
   * The workspace integrations that configure a GitLab instance, including
   * those that are still being connected. They are ordered oldest first, as
   * on the server, so that the same integration of an instance configured more
   * than once by a previous version is used to link accounts.
   */
  @computed
  get gitlab(): Integration<IntegrationType.Embed>[] {
    return sortBy(
      Array.from(this.data.values()).filter(
        (integration) =>
          integration.service === IntegrationService.GitLab &&
          integration.type === IntegrationType.Embed
      ),
      ["createdAt", "id"]
    );
  }

  /**
   * The workspace integrations of GitLab instances that are connected, through
   * which members can link their accounts.
   */
  @computed
  get gitlabConnected(): Integration<IntegrationType.Embed>[] {
    return this.gitlab.filter(
      (integration) => !integration.settings?.gitlab?.pending
    );
  }

  /** The GitLab accounts linked by the current user. */
  @computed
  get gitlabLinkedAccounts(): Integration<IntegrationType.LinkedAccount>[] {
    return this.orderedData.filter(
      (integration) =>
        integration.service === IntegrationService.GitLab &&
        integration.type === IntegrationType.LinkedAccount
    );
  }
}

export default IntegrationsStore;
