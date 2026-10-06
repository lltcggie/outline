import "./bootstrap";
import { Node } from "prosemirror-model";
import { QueryTypes } from "sequelize";
import * as Y from "yjs";
import type { ProsemirrorData } from "@shared/types";
import { ProsemirrorDataHelper } from "@shared/utils/ProsemirrorDataHelper";
import { APIUpdateExtension } from "@server/collaboration/APIUpdateExtension";
import { parser, schema, serializer } from "@server/editor";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { ProsemirrorHelper } from "@server/models/helpers/ProsemirrorHelper";
import { sequelize } from "@server/storage/database";
import { CacheHelper } from "@server/utils/CacheHelper";
import { RedisPrefixHelper } from "@server/utils/RedisPrefixHelper";
import { GitLabUtils } from "plugins/gitlab/shared/GitLabUtils";

/**
 * Removes data unfurled from external services, such as the title and details
 * of GitLab issues, that was stored with mentions before it was only fetched
 * with each viewer's own access. See ProsemirrorDataHelper.removeUnfurledMentionData.
 *
 * Usage: node build/server/scripts/20261005000000-remove-unfurled-mention-data.js [--dry-run]
 *
 * Safe to re-run, and to run while the collaboration server is running. Rows
 * are updated without changing their timestamps.
 */

const limit = 100;

interface Stats {
  documents: number;
  revisions: number;
  comments: number;
  collections: number;
  events: number;
  webhookDeliveries: number;
  gitlabIntegrations: number;
  duplicateGitLabIntegrations: number;
}

interface Options {
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

/**
 * Converts content to the markdown stored in the deprecated text columns.
 *
 * @param content the content to convert.
 * @returns the markdown.
 */
function toText(content: ProsemirrorData) {
  return serializer.serialize(Node.fromJSON(schema, content));
}

/**
 * Cleans an encoded collaborative state, see
 * `ProsemirrorHelper.removeUnfurledMentionDataFromState`. A state that still
 * carries unfurled data, which may be in values that were overwritten or
 * deleted, is always re-encoded through a fresh document so that those are
 * discarded as well.
 *
 * @param state the encoded state.
 * @returns the cleaned state, or undefined when it is unchanged.
 */
function cleanState(state: Buffer): Buffer | undefined {
  if (!state.includes("unfurl")) {
    return ProsemirrorHelper.removeUnfurledMentionDataFromState(state);
  }

  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, state);
    ProsemirrorHelper.removeUnfurledMentionDataFromYDoc(ydoc);
    const cleaned = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    return cleaned.equals(state) ? undefined : cleaned;
  } finally {
    ydoc.destroy();
  }
}

/**
 * Iterates over all rows of a table in pages, ordered by id.
 *
 * @param query the select query, which must filter on `id > :lastId`.
 * @param callback called for each row.
 */
async function eachRow<T extends { id: string }>(
  query: string,
  callback: (row: T) => Promise<void>
) {
  let lastId = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    const rows = await sequelize.query<T>(
      `${query} ORDER BY id ASC LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { lastId, limit } }
    );

    for (const row of rows) {
      await callback(row);
    }

    if (rows.length < limit) {
      return;
    }
    lastId = rows[rows.length - 1].id;
  }
}

/**
 * Computes the cleaned columns of a document row.
 *
 * @param row the document row.
 * @returns the changed columns, empty when nothing changed.
 */
function cleanDocumentRow(row: {
  content: ProsemirrorData | null;
  text: string | null;
  state: Buffer | null;
}) {
  const changes: Record<string, unknown> = {};
  const content = row.content
    ? ProsemirrorDataHelper.removeUnfurledMentionData(row.content)
    : null;

  if (content && content !== row.content) {
    changes.content = JSON.stringify(content);
    if (row.text !== null) {
      changes.text = toText(content);
    }
  } else if (!row.content && row.text) {
    // Older documents only have markdown text, which is parsed into content
    // when they are first opened.
    const parsed = parser.parse(row.text)?.toJSON() as ProsemirrorData;
    const cleaned = ProsemirrorDataHelper.removeUnfurledMentionData(parsed);
    if (cleaned !== parsed) {
      changes.text = toText(cleaned);
    }
  }

  const state = row.state ? cleanState(row.state) : undefined;
  if (state) {
    changes.state = state;
  }

  return changes;
}

/**
 * Removes unfurled mention data from documents and templates, which share the
 * documents table. The markdown text is regenerated so that the search index,
 * updated by trigger, no longer contains the titles.
 *
 * Each document is changed under the same row lock the collaboration server
 * takes when persisting, and the server is notified afterwards so that a
 * document open in an editor picks up the cleaned state. The collaboration
 * server also cleans documents itself before persisting them.
 *
 * @param options the script options.
 * @returns the number of rows changed.
 */
async function cleanDocuments({ dryRun }: Options) {
  let count = 0;

  // Only rows that may contain a mention are loaded, whether they need to be
  // changed is decided under the row lock below.
  await eachRow<{ id: string }>(
    `SELECT id FROM documents WHERE id > :lastId AND (
      content::text LIKE '%"mention"%' OR
      position(convert_to('unfurl', 'UTF8') in state) > 0 OR
      (content IS NULL AND text LIKE '%@[%')
    )`,
    async (candidate) => {
      const changed = await sequelize.transaction(async (transaction) => {
        const [row] = await sequelize.query<{
          content: ProsemirrorData | null;
          text: string | null;
          state: Buffer | null;
          lastModifiedById: string | null;
        }>(
          `SELECT content, text, state, "lastModifiedById" FROM documents WHERE id = :id FOR UPDATE`,
          {
            type: QueryTypes.SELECT,
            replacements: { id: candidate.id },
            transaction,
          }
        );
        if (!row) {
          return undefined;
        }

        const changes = cleanDocumentRow(row);
        if (Object.keys(changes).length === 0) {
          return undefined;
        }

        if (!dryRun) {
          const columns = Object.keys(changes)
            .map((key) =>
              key === "content"
                ? "content = CAST(:content AS jsonb)"
                : `"${key}" = :${key}`
            )
            .join(", ");
          await sequelize.query(
            `UPDATE documents SET ${columns} WHERE id = :id`,
            { replacements: { ...changes, id: candidate.id }, transaction }
          );
        }

        return {
          stateChanged: "state" in changes,
          actorId: row.lastModifiedById,
        };
      });

      if (!changed) {
        return;
      }

      count++;
      if (!dryRun && changed.stateChanged) {
        await APIUpdateExtension.notifyUpdate(
          candidate.id,
          changed.actorId ?? "system"
        );
      }
    }
  );

  return count;
}

interface ContentRow {
  id: string;
  content: ProsemirrorData | null;
  text?: string | null;
}

interface ContentColumn {
  /** The table to clean. */
  table: string;
  /** The jsonb column that holds the content. */
  column: string;
  /** Other columns to select for `derive`. */
  select?: string;
  /** Computes the columns that are derived from the cleaned content. */
  derive?: (
    content: ProsemirrorData,
    row: ContentRow
  ) => Promise<Record<string, unknown>>;
}

/**
 * Removes unfurled mention data from a column holding content, and updates the
 * columns derived from it.
 *
 * @param column the column to clean.
 * @param options the script options.
 * @returns the number of rows changed.
 */
async function cleanContentColumn(
  { table, column, select, derive }: ContentColumn,
  { dryRun }: Options
) {
  let count = 0;

  await eachRow<ContentRow>(
    `SELECT id, "${column}" AS content${select ? `, ${select}` : ""} FROM ${table}
    WHERE id > :lastId AND "${column}"::text LIKE '%"mention"%'`,
    async (row) => {
      const content = row.content
        ? ProsemirrorDataHelper.removeUnfurledMentionData(row.content)
        : null;
      if (!content || content === row.content) {
        return;
      }

      count++;
      if (dryRun) {
        return;
      }

      const derived = derive ? await derive(content, row) : {};
      const columns = [
        `"${column}" = CAST(:content AS jsonb)`,
        ...Object.keys(derived).map((key) => `"${key}" = :${key}`),
      ].join(", ");
      await sequelize.query(`UPDATE ${table} SET ${columns} WHERE id = :id`, {
        replacements: {
          ...derived,
          id: row.id,
          content: JSON.stringify(content),
        },
      });
    }
  );

  return count;
}

/**
 * Removes unfurled mention data from revisions, which can be restored into
 * documents.
 *
 * @param options the script options.
 * @returns the number of rows changed.
 */
function cleanRevisions(options: Options) {
  return cleanContentColumn(
    {
      table: "revisions",
      column: "content",
      select: "text",
      derive: async (content, row) => ({
        text: row.text === null ? null : toText(content),
      }),
    },
    options
  );
}

/**
 * Removes unfurled mention data from comments.
 *
 * @param options the script options.
 * @returns the number of rows changed.
 */
function cleanComments(options: Options) {
  return cleanContentColumn({ table: "comments", column: "data" }, options);
}

/**
 * Removes unfurled mention data from collection descriptions. The markdown
 * description is regenerated, which also updates the search index by trigger.
 *
 * @param options the script options.
 * @returns the number of rows changed.
 */
function cleanCollections(options: Options) {
  return cleanContentColumn(
    {
      table: "collections",
      column: "content",
      derive: async (content) => ({
        description: await DocumentHelper.toMarkdown(content, {
          includeTitle: false,
        }),
      }),
    },
    options
  );
}

/**
 * Clears the recorded changes of events that contain unfurled mention data,
 * such as template and collection updates. The changes also hold markdown
 * copies of the content that cannot be cleaned reliably, so they are removed
 * rather than rewritten.
 *
 * @param options the script options.
 * @returns the number of rows changed.
 */
async function cleanEvents({ dryRun }: Options) {
  let count = 0;

  await eachRow<{ id: string; changes: Record<string, unknown> }>(
    `SELECT id, changes FROM events WHERE id > :lastId AND changes::text LIKE '%"mention"%'`,
    async (row) => {
      if (
        ProsemirrorDataHelper.removeUnfurledMentionData(row.changes) ===
        row.changes
      ) {
        return;
      }

      count++;
      if (dryRun) {
        return;
      }

      await sequelize.query(`UPDATE events SET changes = NULL WHERE id = :id`, {
        replacements: { id: row.id },
      });
    }
  );

  return count;
}

/**
 * Deletes the logs of webhook deliveries that sent unfurled mention data. The
 * delivered requests themselves cannot be recalled.
 *
 * @param options the script options.
 * @returns the number of rows deleted.
 */
async function cleanWebhookDeliveries({ dryRun }: Options) {
  const where = `"requestBody"::text LIKE '%"unfurl":%'`;

  if (dryRun) {
    const [{ count }] = await sequelize.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM webhook_deliveries WHERE ${where}`,
      { type: QueryTypes.SELECT }
    );
    return Number(count);
  }

  const [, result] = await sequelize.query(
    `DELETE FROM webhook_deliveries WHERE ${where}`
  );
  return (result as { rowCount?: number })?.rowCount ?? 0;
}

/**
 * Removes the token and account details that GitLab workspace integrations
 * stored when the workspace was connected with a single account. Previews are
 * now fetched with each user's own linked account, so neither is used.
 *
 * @param options the script options.
 * @returns the number of integrations changed.
 */
async function cleanGitLabIntegrations({ dryRun }: Options) {
  const where = `service = 'gitlab' AND type = 'embed' AND (
    settings #> '{gitlab,installation}' IS NOT NULL OR
    "authenticationId" IN (SELECT id FROM authentications WHERE token IS NOT NULL OR "refreshToken" IS NOT NULL)
  )`;

  const [{ count }] = await sequelize.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM integrations WHERE ${where}`,
    { type: QueryTypes.SELECT }
  );

  if (!dryRun) {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `UPDATE authentications SET token = NULL, "refreshToken" = NULL, "expiresAt" = NULL
        WHERE id IN (SELECT "authenticationId" FROM integrations WHERE service = 'gitlab' AND type = 'embed')
        AND (token IS NOT NULL OR "refreshToken" IS NOT NULL)`,
        { transaction }
      );
      await sequelize.query(
        `UPDATE integrations SET settings = settings #- '{gitlab,installation}'
        WHERE service = 'gitlab' AND type = 'embed' AND settings #> '{gitlab,installation}' IS NOT NULL`,
        { transaction }
      );
    });
  }

  return Number(count);
}

/**
 * Removes duplicate GitLab workspace integrations. A previous version created
 * one integration per connected GitLab account, so a workspace could configure
 * the same instance several times. One integration is kept per instance,
 * preferring one that is connected and, for a self-managed instance, has an
 * OAuth application. Accounts linked through a removed integration are moved
 * to the kept one when both have the same OAuth application, which issued
 * their tokens, and are removed otherwise, as their tokens can no longer be
 * refreshed. See GitLab.releaseLinkedAccounts.
 *
 * @param options the script options.
 * @returns the number of integrations removed.
 */
async function dedupeGitLabIntegrations({ dryRun }: Options) {
  const rows = await sequelize.query<{
    id: string;
    teamId: string;
    url: string | null;
    pending: boolean;
    authenticationId: string | null;
    clientId: string | null;
  }>(
    `SELECT i.id, i."teamId", i.settings #>> '{gitlab,url}' AS url,
      COALESCE((i.settings #>> '{gitlab,pending}')::boolean, false) AS pending,
      i."authenticationId", a."clientId"
    FROM integrations i
    LEFT JOIN authentications a ON a.id = i."authenticationId"
    WHERE i.service = 'gitlab' AND i.type = 'embed' AND i."deletedAt" IS NULL
    ORDER BY i."createdAt" ASC, i.id ASC`,
    { type: QueryTypes.SELECT }
  );

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    // Instances are matched as on the server, see GitLabUtils.isSameInstance.
    const instance = GitLabUtils.normalizeInstanceUrl(row.url ?? undefined);
    const key = `${row.teamId}:${instance}`;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  const removed = Array.from(groups.values()).flatMap((group) => {
    if (group.length < 2) {
      return [];
    }
    const isUsable = (row: (typeof rows)[number]) =>
      !row.pending && (!row.url || !!row.clientId);
    const kept = group.find(isUsable) ?? group[0];
    return group.filter((row) => row !== kept).map((row) => ({ ...row, kept }));
  });

  if (!dryRun && removed.length > 0) {
    await sequelize.transaction(async (transaction) => {
      for (const row of removed) {
        const where = `service = 'gitlab' AND type = 'linkedAccount'
          AND "teamId" = :teamId AND settings #>> '{gitlab,integrationId}' = :id`;
        const replacements = { teamId: row.teamId, id: row.id };

        if ((row.clientId ?? null) === (row.kept.clientId ?? null)) {
          await sequelize.query(
            `UPDATE integrations
            SET settings = jsonb_set(settings, '{gitlab,integrationId}', to_jsonb(CAST(:keptId AS text)))
            WHERE ${where}`,
            {
              replacements: { ...replacements, keptId: row.kept.id },
              transaction,
            }
          );
          continue;
        }

        const linkedAccounts = await sequelize.query<{
          id: string;
          authenticationId: string | null;
        }>(`SELECT id, "authenticationId" FROM integrations WHERE ${where}`, {
          type: QueryTypes.SELECT,
          replacements,
          transaction,
        });
        if (linkedAccounts.length === 0) {
          continue;
        }

        await sequelize.query(`DELETE FROM integrations WHERE id IN (:ids)`, {
          replacements: { ids: linkedAccounts.map((account) => account.id) },
          transaction,
        });
        const accountAuthenticationIds = linkedAccounts
          .map((account) => account.authenticationId)
          .filter((id): id is string => !!id);
        if (accountAuthenticationIds.length > 0) {
          await sequelize.query(
            `DELETE FROM authentications WHERE id IN (:ids)`,
            { replacements: { ids: accountAuthenticationIds }, transaction }
          );
        }
      }

      await sequelize.query(`DELETE FROM integrations WHERE id IN (:ids)`, {
        replacements: { ids: removed.map((row) => row.id) },
        transaction,
      });

      const authenticationIds = removed
        .map((row) => row.authenticationId)
        .filter((id): id is string => !!id);
      if (authenticationIds.length > 0) {
        await sequelize.query(
          `DELETE FROM authentications WHERE id IN (:ids)`,
          { replacements: { ids: authenticationIds }, transaction }
        );
      }
    });
  }

  return removed.length;
}

/**
 * Runs the cleanup.
 *
 * @param options the script options.
 * @param exit whether to exit the process when complete.
 * @returns the number of rows changed per table.
 */
export default async function main(
  options: Options = {},
  exit = false
): Promise<Stats> {
  const stats: Stats = {
    documents: await cleanDocuments(options),
    revisions: await cleanRevisions(options),
    comments: await cleanComments(options),
    collections: await cleanCollections(options),
    events: await cleanEvents(options),
    webhookDeliveries: await cleanWebhookDeliveries(options),
    gitlabIntegrations: await cleanGitLabIntegrations(options),
    duplicateGitLabIntegrations: await dedupeGitLabIntegrations(options),
  };

  if (!options.dryRun) {
    // Cached unfurls were shared within a team, and cached email diffs may
    // contain rendered mentions.
    await CacheHelper.clearData(RedisPrefixHelper.getUnfurlPrefix());
    await CacheHelper.clearData("diff:");
  }

  if (exit) {
    console.log(
      `${options.dryRun ? "Would change" : "Changed"}: ${JSON.stringify(stats)}`
    );
    process.exit(0);
  }

  return stats;
}

if (process.env.NODE_ENV !== "test") {
  void main({ dryRun: process.argv.includes("--dry-run") }, true);
}
