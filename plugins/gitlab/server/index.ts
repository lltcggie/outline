import type { EmbedIntegrationSettings } from "@shared/types";
import { IntegrationService, IntegrationType } from "@shared/types";
import { Minute } from "@shared/utils/time";
import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import { GitLabUtils } from "../shared/GitLabUtils";
import { GitLabIssueProvider } from "./GitLabIssueProvider";
import router from "./api/gitlab";
import { GitLabSettingsSchema } from "./api/schema";
import { GitLab } from "./gitlab";
import env from "./env";
import GitLabWebhookTask from "./tasks/GitLabWebhookTask";
import { uninstall } from "./uninstall";

PluginManager.add([
  {
    type: Hook.IntegrationSettings,
    value: {
      service: IntegrationService.GitLab,
      keys: ["gitlab"],
      schema: GitLabSettingsSchema,
      // Guests link their own account too, for which the instance is needed.
      visibleToGuests: true,
      // Only the instance URL and state of a workspace integration are needed
      // by clients, account details of a legacy connection must not be visible
      // to every member. A linked account is only presented to its owner.
      present: (_key, value, integration) => {
        if (integration.type !== IntegrationType.Embed || !value) {
          return value;
        }
        const { url, pending } = value as NonNullable<
          EmbedIntegrationSettings["gitlab"]
        >;
        return { url, pending };
      },
    },
  },
  {
    ...config,
    type: Hook.API,
    value: router,
  },
  {
    type: Hook.IssueProvider,
    value: new GitLabIssueProvider(),
  },
  {
    type: Hook.UnfurlProvider,
    name: "GitLab",
    value: {
      unfurl: GitLab.unfurl,
      cacheExpiry: Minute.seconds,
      // Resources are only fetched with the account linked by the user.
      userAccess: true,
    },
  },
  {
    // Mentions are never narrowed once displayed, so the type is decided here.
    // A self-managed instance is only known synchronously through GITLAB_URL.
    type: Hook.MentionProvider,
    value: (url: URL) =>
      GitLabUtils.mentionType(url) ??
      GitLabUtils.mentionType(url, env.GITLAB_URL),
  },
  {
    type: Hook.Task,
    value: GitLabWebhookTask,
  },
  {
    type: Hook.Uninstall,
    value: uninstall,
  },
]);
