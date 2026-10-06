import { Minute } from "@shared/utils/time";
import { PluginManager, Hook } from "@server/utils/PluginManager";
import config from "../plugin.json";
import { GitLabUtils } from "../shared/GitLabUtils";
import { GitLabIssueProvider } from "./GitLabIssueProvider";
import router from "./api/gitlab";
import { GitLab } from "./gitlab";
import env from "./env";
import GitLabWebhookTask from "./tasks/GitLabWebhookTask";
import { uninstall } from "./uninstall";

PluginManager.add([
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
    value: { unfurl: GitLab.unfurl, cacheExpiry: Minute.seconds },
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
