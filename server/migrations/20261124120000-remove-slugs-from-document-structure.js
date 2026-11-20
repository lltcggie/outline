"use strict";

const batchSize = 100;

// A url with a slugified title before the urlId, which has no hyphen itself.
const withSlugRegex = /^\/doc\/[0-9a-zA-Z-_~]*-([a-zA-Z0-9]{10,15})$/;

/**
 * Removes the slugified title from the url of each node in a document
 * structure, leaving `/doc/<urlId>`.
 *
 * @param {unknown} nodes the document structure, changed in place.
 * @returns {boolean} whether any url was changed.
 */
function removeSlugs(nodes) {
  if (!Array.isArray(nodes)) {
    return false;
  }

  let changed = false;
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }
    const match =
      typeof node.url === "string" ? withSlugRegex.exec(node.url) : null;
    if (match) {
      node.url = `/doc/${match[1]}`;
      changed = true;
    }
    if (removeSlugs(node.children)) {
      changed = true;
    }
  }
  return changed;
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Document urls no longer include the title, see Document.getPath. The
    // urls stored in collections are otherwise only rewritten when a document
    // is next renamed.
    const { sequelize } = queryInterface;
    const { SELECT } = sequelize.QueryTypes;
    let lastId = "00000000-0000-0000-0000-000000000000";

    for (;;) {
      const rows = await sequelize.query(
        `SELECT id, "documentStructure" FROM collections WHERE id > :lastId ORDER BY id ASC LIMIT :batchSize`,
        { type: SELECT, replacements: { lastId, batchSize } }
      );

      for (const row of rows) {
        if (!removeSlugs(row.documentStructure)) {
          continue;
        }

        // Read again under the lock that the server takes to change the
        // structure, an instance of another version may still be running.
        await sequelize.transaction(async (transaction) => {
          const [locked] = await sequelize.query(
            `SELECT "documentStructure" FROM collections WHERE id = :id FOR NO KEY UPDATE`,
            { type: SELECT, replacements: { id: row.id }, transaction }
          );
          if (!locked || !removeSlugs(locked.documentStructure)) {
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
  },

  async down() {
    // Nothing to put back: the version before this one opens `/doc/<urlId>`,
    // and the title in a url is never used to find the document.
  },
};
