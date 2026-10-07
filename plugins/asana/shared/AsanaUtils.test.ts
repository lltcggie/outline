import { MentionType } from "@shared/types";
import { AsanaUtils } from "./AsanaUtils";

describe("AsanaUtils.parseUrl", () => {
  it.each([
    [
      "https://app.asana.com/1/1209288636362503/project/1209325819715595/task/1209400000000001",
      { type: "task", gid: "1209400000000001", projectGid: "1209325819715595" },
    ],
    [
      "https://app.asana.com/1/1209288636362503/project/1209325819715595/task/1209400000000001?focus=true",
      { type: "task", gid: "1209400000000001", projectGid: "1209325819715595" },
    ],
    [
      "https://app.asana.com/1/1209288636362503/task/1209400000000001",
      { type: "task", gid: "1209400000000001", projectGid: undefined },
    ],
    [
      "https://app.asana.com/1/1209288636362503/project/1209325819715595/list/1209328572071561",
      { type: "project", gid: "1209325819715595" },
    ],
    [
      "https://app.asana.com/1/1209288636362503/project/1209325819715595/board/1209328572071562",
      { type: "project", gid: "1209325819715595" },
    ],
    [
      "https://app.asana.com/0/1209325819715595/1209400000000001",
      { type: "task", gid: "1209400000000001", projectGid: "1209325819715595" },
    ],
    [
      "https://app.asana.com/0/1209325819715595/1209400000000001/f",
      { type: "task", gid: "1209400000000001", projectGid: "1209325819715595" },
    ],
    [
      "https://app.asana.com/0/0/1209400000000001",
      { type: "task", gid: "1209400000000001", projectGid: undefined },
    ],
    [
      "https://app.asana.com/0/1209325819715595/list",
      { type: "project", gid: "1209325819715595" },
    ],
    // Asana redirects http to https, the link points at the same task.
    [
      "http://app.asana.com/0/0/1209400000000001",
      { type: "task", gid: "1209400000000001", projectGid: undefined },
    ],
  ])("parses %s", (url, expected) => {
    expect(AsanaUtils.parseUrl(url)).toEqual(expected);
  });

  it.each([
    "https://app.asana.com/0/inbox/1209288636362503",
    "https://app.asana.com/0/search/123/456",
    "https://app.asana.com/0/home/1209288636362503",
    "https://app.asana.com/1/1209288636362503/home",
    "https://app.asana.com/1/1209288636362503/inbox",
    "https://asana.com/1/1209288636362503/task/1209400000000001",
    "https://linear.app/team/issue/ABC-1",
    "not a url",
  ])("ignores %s", (url) => {
    expect(AsanaUtils.parseUrl(url)).toBeUndefined();
  });
});

describe("AsanaUtils.mentionType", () => {
  it.each([
    [
      "https://app.asana.com/1/1209288636362503/project/1209325819715595/task/1209400000000001",
      MentionType.Issue,
    ],
    ["https://app.asana.com/0/0/1209400000000001", MentionType.Issue],
    [
      "https://app.asana.com/1/1209288636362503/project/1209325819715595/list/1209328572071561",
      MentionType.Project,
    ],
    ["https://app.asana.com/0/1209325819715595/list", MentionType.Project],
    ["https://app.asana.com/0/inbox/1209288636362503", undefined],
    ["https://example.com/0/1209325819715595/list", undefined],
  ])("determines the mention type of %s", (url, expected) => {
    expect(AsanaUtils.mentionType(new URL(url))).toEqual(expected);
  });
});

describe("AsanaUtils.getColorForProject", () => {
  it("should map Asana color names to hex colors", () => {
    expect(AsanaUtils.getColorForProject("dark-pink")).toEqual("#e362e3");
    expect(AsanaUtils.getColorForProject("none")).toEqual(
      AsanaUtils.defaultProjectColor
    );
    expect(AsanaUtils.getColorForProject(null)).toEqual(
      AsanaUtils.defaultProjectColor
    );
  });
});

describe("AsanaUtils.isAsanaUrl", () => {
  it("should recognize URLs on app.asana.com only", () => {
    expect(AsanaUtils.isAsanaUrl("https://app.asana.com/0/inbox/1")).toBe(true);
    expect(AsanaUtils.isAsanaUrl("https://asana.com/0/inbox/1")).toBe(false);
    // Not passed on to other providers either, Asana redirects it to https.
    expect(AsanaUtils.isAsanaUrl("http://app.asana.com/0/inbox/1")).toBe(true);
    expect(AsanaUtils.isAsanaUrl("not a url")).toBe(false);
  });
});

describe("AsanaUtils.authUrl", () => {
  it("should include the client id, scopes and state", () => {
    const url = new URL(
      AsanaUtils.authUrl(
        { teamId: "team", nonce: "nonce" },
        "client-id",
        "tasks:read projects:read"
      )
    );

    expect(url.origin + url.pathname).toEqual(AsanaUtils.authorizeUrl);
    expect(url.searchParams.get("client_id")).toEqual("client-id");
    expect(url.searchParams.get("scope")).toEqual("tasks:read projects:read");
    expect(url.searchParams.get("response_type")).toEqual("code");
    expect(url.searchParams.get("redirect_uri")).toEqual(
      AsanaUtils.callbackUrl()
    );
    expect(AsanaUtils.parseState(url.searchParams.get("state")!)).toEqual({
      teamId: "team",
      nonce: "nonce",
    });
  });
});
