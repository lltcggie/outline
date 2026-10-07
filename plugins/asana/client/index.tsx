import { createLazyComponent } from "~/components/LazyLoad";
import env from "~/env";
import { Hook, PluginManager } from "~/utils/PluginManager";
import config from "../plugin.json";
import { AsanaUtils } from "../shared/AsanaUtils";
import { AsanaIcon } from "./Icon";

PluginManager.add([
  {
    ...config,
    type: Hook.Settings,
    value: {
      group: "Integrations",
      icon: AsanaIcon,
      description:
        "Connect your Asana account to Outline to enable rich task and project previews inside documents.",
      // Every member links their own account, previews use their own access.
      // Until the integration is configured only admins see it.
      enabled: (_team, user) => !!env.ASANA_CLIENT_ID || user.isAdmin,
      component: createLazyComponent(() => import("./Settings")),
    },
  },
]);

// Links to tasks and projects become issue and project mentions whether or
// not the viewer has linked an account yet, as the type is decided when the
// mention is created.
if (env.ASANA_CLIENT_ID) {
  PluginManager.add({
    ...config,
    type: Hook.MentionProvider,
    value: (url: URL) => AsanaUtils.mentionType(url),
  });
}
