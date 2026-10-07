import { isAsanaUrl } from "./integrations";

describe("isAsanaUrl", () => {
  it.each([
    ["https://app.asana.com/0/1/2", true],
    ["https://github.com/outline/outline/issues/1", false],
    ["https://linear.app/outline/issue/OUT-1", false],
    ["https://gitlab.example.com/group/project/-/issues/1", false],
    ["https://asana.example.com/0/1/2", false],
    ["not a url", false],
    [undefined, false],
  ])("checks %s", (url, expected) => {
    expect(isAsanaUrl(url)).toEqual(expected);
  });
});
