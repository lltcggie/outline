import { Hook, PluginManager } from "@server/utils/PluginManager";
import config from "../plugin.json";
import { AsanaUtils } from "../shared/AsanaUtils";
import router from "./api/asana";
import { Asana } from "./asana";
import env from "./env";

const enabled = !!env.ASANA_CLIENT_ID && !!env.ASANA_CLIENT_SECRET;

if (enabled) {
  PluginManager.add([
    {
      ...config,
      type: Hook.API,
      value: router,
    },
    {
      type: Hook.UnfurlProvider,
      // Cached per user, as resources are fetched with the user's own account
      // and results contain text localized for the user.
      value: { unfurl: Asana.unfurl, cacheExpiry: env.ASANA_CACHE_SECONDS },
    },
    {
      type: Hook.MentionProvider,
      value: (url: URL) => AsanaUtils.mentionType(url),
    },
  ]);
}
