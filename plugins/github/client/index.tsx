import { createLazyComponent } from "~/components/LazyLoad";
import env from "~/env";
import { Hook, PluginManager } from "~/utils/PluginManager";
import config from "../plugin.json";
import { GitHubUtils } from "../shared/GitHubUtils";
import Icon from "./Icon";

PluginManager.add([
  {
    ...config,
    type: Hook.Settings,
    value: {
      group: "Integrations",
      icon: Icon,
      description:
        "Connect your GitHub account to Outline to enable rich, realtime, issue and pull request previews inside documents.",
      // Every member links their own account, previews use their own access.
      // Until the integration is configured only admins see it.
      enabled: (_team, user) => !!env.GITHUB_CLIENT_ID || user.isAdmin,
      component: createLazyComponent(() => import("./Settings")),
    },
  },
]);

// Links to issues, pull requests and projects become mentions of their type
// whether or not the viewer has linked an account yet, as the type is decided
// when the mention is created.
if (env.GITHUB_CLIENT_ID) {
  PluginManager.add({
    ...config,
    type: Hook.MentionProvider,
    value: (url: URL) => GitHubUtils.mentionType(url),
  });
}
