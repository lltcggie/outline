import { IntegrationService } from "../types";
import { getIssueTrackerService } from "./integrations";

describe("getIssueTrackerService", () => {
  it.each([
    ["https://github.com/outline/outline/issues/1", IntegrationService.GitHub],
    ["https://linear.app/team/issue/ABC-1", IntegrationService.Linear],
    ["https://app.asana.com/0/1/2", IntegrationService.Asana],
    ["https://gitlab.com/group/project/-/issues/1", IntegrationService.GitLab],
    [
      "https://gitlab.example.com/group/project/-/issues/1",
      IntegrationService.GitLab,
    ],
    ["not a url", IntegrationService.GitLab],
  ])("recognizes %s", (url, expected) => {
    expect(getIssueTrackerService(url)).toEqual(expected);
  });
});
