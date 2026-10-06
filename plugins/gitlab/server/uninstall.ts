import { IntegrationService, IntegrationType } from "@shared/types";
import { IntegrationAuthentication } from "@server/models";
import type { Integration } from "@server/models";
import { GitLab } from "./gitlab";

/**
 * Removes the accounts users linked through a GitLab workspace integration
 * when the integration is removed, so that their tokens are not left behind.
 * Accounts are kept while another workspace integration of the same instance
 * still has the OAuth application that issued their tokens, such as one
 * connected again before this ran, see GitLab.releaseLinkedAccounts.
 *
 * @param integration the integration being uninstalled.
 */
export async function uninstall(integration: Integration) {
  if (
    integration.service !== IntegrationService.GitLab ||
    integration.type !== IntegrationType.Embed
  ) {
    return;
  }

  // The authentication is only removed after the uninstall hooks have run.
  const authentication = integration.authenticationId
    ? await IntegrationAuthentication.findByPk(integration.authenticationId)
    : null;

  await GitLab.releaseLinkedAccounts(
    integration as Integration<IntegrationType.Embed>,
    authentication?.clientId
  );
}
