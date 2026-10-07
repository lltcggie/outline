import { MentionType } from "@shared/types";
import type Integration from "~/models/Integration";
import { Hook, PluginManager } from "~/utils/PluginManager";

/**
 * Returns the mention provider registered for the service of an integration.
 *
 * @param integration the integration to find a provider for.
 * @returns the provider, or undefined if no plugin handles the service.
 */
const getMentionProvider = (integration: Integration) =>
  PluginManager.getHooks(Hook.MentionProvider).find(
    (hook) => hook.value.service === integration.service
  )?.value;

/**
 * Checks whether a URL can be converted to a mention for the given
 * integration.
 *
 * @param options the URL and integration to check against.
 * @returns true if the URL can be mentioned through the integration.
 */
export const isURLMentionable = ({
  url,
  integration,
}: {
  url: URL;
  integration: Integration;
}): boolean =>
  getMentionProvider(integration)?.isMentionable(url, integration) ?? false;

/**
 * Determines the type of mention a URL represents for the given integration,
 * such as an issue, pull request, or project.
 *
 * @param options the URL and integration to evaluate.
 * @returns the mention type, or undefined if the URL is not recognized.
 */
export const determineMentionType = ({
  url,
  integration,
}: {
  url: URL;
  integration: Integration;
}): MentionType | undefined =>
  getMentionProvider(integration)?.mentionType(url, integration);

/**
 * Determines the type of mention a pasted URL is converted to: the type a
 * workspace integration recognizes, the type of a resource on a service that
 * members link their own accounts to, or otherwise a plain URL mention.
 *
 * @param options the URL and the workspace integrations to check against.
 * @returns the mention type, or undefined if the URL cannot be mentioned.
 */
export const getMentionTypeForURL = ({
  url,
  integrations,
}: {
  url: URL;
  integrations: Integration[];
}): MentionType | undefined => {
  const integration = integrations.find((candidate) =>
    isURLMentionable({ url, integration: candidate })
  );
  if (integration) {
    return determineMentionType({ url, integration });
  }

  // Services that members link their own accounts to have no workspace
  // integration, the plugin recognizes their URLs instead.
  for (const provider of PluginManager.getHooks(Hook.UrlMentionProvider)) {
    const type = provider.value(url);
    if (type) {
      return type;
    }
  }

  return MentionType.URL;
};
