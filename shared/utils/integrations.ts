import type { IssueTrackerIntegrationService } from "../types";
import { IntegrationService } from "../types";

/**
 * Determines the issue tracker an unfurled issue, pull request or project
 * belongs to from its URL, which decides how its status is displayed.
 *
 * @param url the URL of the resource.
 * @returns the issue tracker service, GitLab when the host is not one of the
 * cloud services as it can be self-managed on any host.
 */
export function getIssueTrackerService(
  url: string
): IssueTrackerIntegrationService {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return IntegrationService.GitLab;
  }

  switch (hostname) {
    case "github.com":
      return IntegrationService.GitHub;
    case "linear.app":
      return IntegrationService.Linear;
    case "app.asana.com":
      return IntegrationService.Asana;
    default:
      return IntegrationService.GitLab;
  }
}
