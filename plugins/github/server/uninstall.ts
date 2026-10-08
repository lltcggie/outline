import { IntegrationService, IntegrationType } from "@shared/types";
import { IntegrationAuthentication } from "@server/models";
import type { Integration } from "@server/models";
import { GitHub } from "./github";

/**
 * Cleans up in GitHub when an integration is removed: the app is uninstalled
 * from the organization or account of a workspace integration, and the token
 * of a linked account is revoked so that it cannot be used any more. Other
 * linked accounts are kept when an installation is removed, their tokens
 * belong to the app rather than to the installation.
 *
 * @param integration the integration being uninstalled.
 */
export async function uninstall(integration: Integration) {
  if (integration.service !== IntegrationService.GitHub) {
    return;
  }

  if (integration.type === IntegrationType.Embed) {
    await uninstallApp(integration);
    return;
  }

  if (integration.type === IntegrationType.LinkedAccount) {
    // The authentication is only removed after the uninstall hooks have run.
    const authentication = integration.authenticationId
      ? await IntegrationAuthentication.findByPk(integration.authenticationId)
      : null;

    if (authentication?.token) {
      await GitHub.discardToken(authentication.token);
    }
  }
}

/**
 * Uninstalls the app from the organization or account whose installation a
 * workspace integration records.
 *
 * @param integration the workspace integration being removed.
 */
async function uninstallApp(integration: Integration<IntegrationType.Embed>) {
  const installationId = integration.settings?.github?.installation.id;
  if (!installationId) {
    return;
  }

  const client = await GitHub.authenticateAsInstallation(installationId);
  await client.requestAppUninstall(installationId);
}
