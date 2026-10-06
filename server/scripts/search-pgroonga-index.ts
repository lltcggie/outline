/* oxlint-disable no-console */
import "./bootstrap";
import env from "@server/env";
import { sequelize } from "@server/storage/database";
import {
  installPGroongaIndex,
  isPGroongaAvailable,
  uninstallPGroongaIndex,
} from "plugins/search-pgroonga/server/pgroongaIndex";

/**
 * Creates or removes the PGroonga search index that the search-pgroonga plugin
 * (SEARCH_PROVIDER=pgroonga) requires. See docs/FORK.md.
 *
 * Usage: node build/server/scripts/search-pgroonga-index.js [install|uninstall]
 *
 * install   creates the pgroonga extension (needs a superuser unless it already
 *           exists), the text extraction functions and the index. The index is
 *           built without blocking writes, so Outline can keep running. Safe to
 *           re-run, including after an interrupted build.
 * uninstall drops the index and the functions. Set SEARCH_PROVIDER back to
 *           "postgres" and restart Outline first.
 */

type Action = "install" | "uninstall";

const USAGE =
  "Usage: node build/server/scripts/search-pgroonga-index.js [install|uninstall]";

/**
 * Runs the given action.
 *
 * @param action what to do.
 * @param exit whether to exit the process when complete.
 */
export default async function main(action: Action, exit = false) {
  if (action === "install") {
    if (!(await isPGroongaAvailable(sequelize))) {
      throw new Error(
        "PGroonga is not installed on the PostgreSQL server. Install it first, e.g. by running the groonga/pgroonga Docker image, then run this script again."
      );
    }
    await installPGroongaIndex(sequelize, { log: console.log });
    console.log(
      `Done. Set SEARCH_PROVIDER=pgroonga and restart Outline to use the index.`
    );
  } else {
    if (env.SEARCH_PROVIDER === "pgroonga") {
      throw new Error(
        `SEARCH_PROVIDER is still "pgroonga". Set it to "postgres" (or unset it) and restart Outline before uninstalling the index.`
      );
    }
    await uninstallPGroongaIndex(sequelize, { log: console.log });
    console.log("Done.");
  }

  if (exit) {
    process.exit(0);
  }
}

if (process.env.NODE_ENV !== "test") {
  const [action = "install"] = process.argv.slice(2);

  if (action !== "install" && action !== "uninstall") {
    console.error(USAGE);
    process.exit(1);
  }

  main(action, true).catch((err: Error) => {
    console.error(err.message);
    if (/permission denied to create extension/i.test(err.message)) {
      console.error(
        `Run "CREATE EXTENSION pgroonga;" on the Outline database as a superuser, then run this script again.`
      );
    }
    process.exit(1);
  });
}
