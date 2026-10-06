import { subMinutes } from "date-fns";
import { UnfurlResourceType } from "@shared/types";
import stores from "~/stores";
import { client } from "~/utils/ApiClient";

const url = "https://gitlab.example.com/group/project/-/issues/1";
const issue = { type: UnfurlResourceType.Issue, title: "Issue", url };

describe("UnfurlsStore", () => {
  beforeEach(() => {
    stores.unfurls.clear();
    vi.mocked(client.post).mockReset();
  });

  it("should share one request between concurrent fetches of a url", async () => {
    vi.mocked(client.post).mockResolvedValue(issue);

    const [first, second] = await Promise.all([
      stores.unfurls.fetchUnfurl({ url }),
      stores.unfurls.fetchUnfurl({ url }),
    ]);

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(stores.unfurls.get(url)?.data).toEqual(issue);
  });

  it("should request again once a fetch has completed", async () => {
    vi.mocked(client.post).mockResolvedValue(undefined);

    await stores.unfurls.fetchUnfurl({ url });
    await stores.unfurls.fetchUnfurl({ url });

    expect(client.post).toHaveBeenCalledTimes(2);
  });

  it("should discard a stale result when the resource can no longer be seen", async () => {
    stores.unfurls.add({
      id: url,
      type: issue.type,
      fetchedAt: subMinutes(new Date(), 6).toISOString(),
      data: issue,
    });
    vi.mocked(client.post).mockResolvedValue(undefined);

    // The stale result is returned while it is fetched again.
    expect(await stores.unfurls.fetchUnfurl({ url })).toBeDefined();
    await vi.waitFor(() => {
      expect(stores.unfurls.get(url)).toBeUndefined();
    });
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("should ignore urls that cannot be unfurled", async () => {
    expect(
      await stores.unfurls.fetchUnfurl({ url: "javascript:alert(1)" })
    ).toBeUndefined();
    expect(await stores.unfurls.fetchUnfurl({ url: "not a url" })).toBe(
      undefined
    );
    expect(client.post).not.toHaveBeenCalled();
  });
});
