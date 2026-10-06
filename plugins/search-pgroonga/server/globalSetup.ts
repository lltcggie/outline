/**
 * Runs once before the workers of the server-pgroonga test project start, see
 * vitest.config.ts: creates the PGroonga index on the test database, and
 * closes the connection once every test has run.
 *
 * @returns the teardown.
 */
export default async function setup() {
  const { sequelize } = await import("@server/storage/database");
  const { LockHelper } = await import("@server/storage/LockHelper");
  const { hasPGroongaIndex, installPGroongaIndex } =
    await import("./pgroongaIndex");

  // A valid index implies the functions it is built on are current: changing
  // them means renaming the index, see pgroongaIndex.ts.
  if (!(await hasPGroongaIndex(sequelize))) {
    // Several shards may prepare the same database at once, the lock
    // serializes them. A concurrent build cannot run in a transaction, and
    // the test database is small enough not to need one.
    await sequelize.transaction(async (transaction) => {
      await LockHelper.acquire(sequelize, "search-pgroonga", transaction);
      await installPGroongaIndex(sequelize, {
        concurrently: false,
        transaction,
      });
    });
  }

  return async () => {
    await sequelize.close();
  };
}
