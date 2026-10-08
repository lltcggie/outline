import { sortBy } from "es-toolkit/compat";
import { computed, override } from "mobx";
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
   * Fetches the integrations of a service and takes those the server no
   * longer returns out of the store. Fetching only ever adds to the store, so
   * an integration removed without the client being told, such as a linked
   * account that the server removes when the user revokes the application in
   * the service, would otherwise still be shown as connected.
   *
   * @param service the service whose integrations are fetched.
   * @param params further parameters of the request, such as withRelations.
   * They must not narrow the result, such as to a type, as every integration
   * of the service that is not returned is taken out of the store.
   * @returns the integrations of the service.
   */
  fetchService = async (
    service: IntegrationService,
    params?: Record<string, unknown>
  ) => {
    const results = await this.fetchAll({ ...params, service });
    const ids = new Set(results.map((integration) => integration.id));
    this.removeAll(
      (integration) =>
        integration.service === service && !ids.has(integration.id)
    );
    return results;
  };

  @override
  get orderedData(): Integration[] {
    return naturalSort(Array.from(this.data.values()), "name");
  }

  /**
   * The workspace integrations that record an installation of the GitHub app
   * on an organization or account, which admins add so that the app can
   * reach its repositories.
   */
  @computed
  get github(): Integration<IntegrationType.Embed>[] {
    return this.orderedData.filter(
      (integration) =>
        integration.service === IntegrationService.GitHub &&
        integration.type === IntegrationType.Embed
    );
  }

  /** The GitHub account linked by the current user, if any. */
  @computed
  get githubLinkedAccount():
    | Integration<IntegrationType.LinkedAccount>
    | undefined {
    return this.orderedData.find(
      (integration) =>
        integration.service === IntegrationService.GitHub &&
        integration.type === IntegrationType.LinkedAccount
    );
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

  @computed
  get linear(): Integration<IntegrationType.Embed>[] {
    return this.orderedData.filter(
      (integration) => integration.service === IntegrationService.Linear
    );
  }
}

export default IntegrationsStore;
