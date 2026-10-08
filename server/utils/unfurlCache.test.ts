import Logger from "@server/logging/Logger";
import { sequelize } from "@server/storage/database";
import { CacheHelper } from "./CacheHelper";
import { clearUnfurlCacheAfterCommit } from "./unfurlCache";

const keys = {
  user: "unfurl:team-1:user-1:https://example.com/a",
  team: "unfurl:team-2:shared:https://example.com/b",
  other: "unfurl:team-3:user-3:https://example.com/c",
};

describe("clearUnfurlCacheAfterCommit", () => {
  beforeEach(async () => {
    await Promise.all(
      Object.values(keys).map((key) => CacheHelper.setData(key, "cached", 60))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should clear the cached unfurls of the given scopes once the transaction commits", async () => {
    await sequelize.transaction(async (transaction) => {
      clearUnfurlCacheAfterCommit(transaction, [
        { teamId: "team-1", userId: "user-1" },
        { teamId: "team-2" },
      ]);

      // Nothing is cleared before the commit.
      expect(await CacheHelper.getData(keys.user)).toEqual("cached");
      expect(await CacheHelper.getData(keys.team)).toEqual("cached");
    });

    expect(await CacheHelper.getData(keys.user)).toBeUndefined();
    expect(await CacheHelper.getData(keys.team)).toBeUndefined();
    expect(await CacheHelper.getData(keys.other)).toEqual("cached");
  });

  it("should keep the cached unfurls when the transaction rolls back", async () => {
    await expect(
      sequelize.transaction(async (transaction) => {
        clearUnfurlCacheAfterCommit(transaction, [{ teamId: "team-1" }]);
        throw new Error("rolled back");
      })
    ).rejects.toThrow("rolled back");

    expect(await CacheHelper.getData(keys.user)).toEqual("cached");
  });

  it("should warn rather than fail when the cache cannot be reached", async () => {
    vi.spyOn(CacheHelper, "clearData").mockRejectedValue(
      new Error("connection refused")
    );
    const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {});

    await expect(
      sequelize.transaction(async (transaction) => {
        clearUnfurlCacheAfterCommit(transaction, [{ teamId: "team-1" }]);
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cached unfurls"),
      expect.any(Error)
    );
  });
});
