"use strict";

const batchSize = 100;

// An unreadable slug has no hyphen, so urls with a readable slug do not match.
const withSlugRegex = /^\/doc\/([a-z0-9]+)-([a-zA-Z0-9]{10,15})$/;
const withoutSlugRegex = /^\/doc\/([a-zA-Z0-9]{10,15})$/;

/**
 * @callback Rewrite
 * @param {{ url: string, title: string }} node a node of a document structure.
 * @returns {string | undefined} the new url, or undefined to leave it as it is.
 */

/**
 * Returns the slug that a title used to get when it had no character that a
 * slug can represent, such as a title written entirely in kana: the base64
 * encoding of the title, lowercased, without `+`, `/` and `=`.
 *
 * @param {string} title the title of the document.
 * @returns {string} the slug.
 */
function unreadableSlug(title) {
  return Buffer.from(title.toWellFormed(), "utf8")
    .toString("base64")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Returns the url of a node without its unreadable slug, `/doc/<urlId>`.
 *
 * @type {Rewrite}
 */
function withoutUnreadableSlug(node) {
  const match = withSlugRegex.exec(node.url);
  return match && match[1] === unreadableSlug(node.title)
    ? `/doc/${match[2]}`
    : undefined;
}

/**
 * Returns the url of a node with the unreadable slug that it had before, for a
 * node whose url is only `/doc/<urlId>`.
 *
 * @type {Rewrite}
 */
function withUnreadableSlug(node) {
  const match = withoutSlugRegex.exec(node.url);
  return match ? `/doc/${unreadableSlug(node.title)}-${match[1]}` : undefined;
}

/**
 * Rewrites the url of each node in a document structure.
 *
 * @param {unknown} nodes the document structure, changed in place.
 * @param {Rewrite} rewrite returns the new url of each node.
 * @returns {boolean} whether any url was changed.
 */
function rewriteUrls(nodes, rewrite) {
  if (!Array.isArray(nodes)) {
    return false;
  }

  let changed = false;
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }
    if (typeof node.url === "string" && typeof node.title === "string") {
      const url = rewrite(node);
      if (url !== undefined) {
        node.url = url;
        changed = true;
      }
    }
    if (rewriteUrls(node.children, rewrite)) {
      changed = true;
    }
  }
  return changed;
}

/**
 * Rewrites the urls stored in the document structure of every collection.
 *
 * @param {import('sequelize').QueryInterface} queryInterface the query interface.
 * @param {Rewrite} rewrite returns the new url of each node.
 */
async function rewriteDocumentStructures(queryInterface, rewrite) {
  const { sequelize } = queryInterface;
  const { SELECT } = sequelize.QueryTypes;
  let lastId = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    const rows = await sequelize.query(
      `SELECT id, "documentStructure" FROM collections WHERE id > :lastId ORDER BY id ASC LIMIT :batchSize`,
      { type: SELECT, replacements: { lastId, batchSize } }
    );

    for (const row of rows) {
      if (!rewriteUrls(row.documentStructure, rewrite)) {
        continue;
      }

      // Read again under the lock that the server takes to change the
      // structure, an instance of another version may still be running.
      await sequelize.transaction(async (transaction) => {
        const [locked] = await sequelize.query(
          `SELECT "documentStructure" FROM collections WHERE id = :id FOR NO KEY UPDATE`,
          { type: SELECT, replacements: { id: row.id }, transaction }
        );
        if (!locked || !rewriteUrls(locked.documentStructure, rewrite)) {
          return;
        }

        await sequelize.query(
          `UPDATE collections SET "documentStructure" = CAST(:documentStructure AS jsonb) WHERE id = :id`,
          {
            replacements: {
              id: row.id,
              documentStructure: JSON.stringify(locked.documentStructure),
            },
            transaction,
          }
        );
      });
    }

    if (rows.length < batchSize) {
      return;
    }
    lastId = rows[rows.length - 1].id;
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Document urls no longer include a slug when the title has no character
    // that a slug can represent, see Document.getPath. The urls stored in
    // collections are otherwise only rewritten when a document is next renamed.
    await rewriteDocumentStructures(queryInterface, withoutUnreadableSlug);
  },

  async down(queryInterface) {
    // A version without this change does not route `/doc/<urlId>`, so the
    // slugs are put back, including on urls stored since the migration ran.
    await rewriteDocumentStructures(queryInterface, withUnreadableSlug);
  },
};
