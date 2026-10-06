import { QueryTypes } from "sequelize";
import type { Sequelize, Transaction } from "sequelize";

/**
 * Name of the PGroonga index over documents. Changing what the index contains
 * means renaming it as well, so that an instance still carrying the previous
 * index fails loudly instead of searching through stale data.
 */
export const PGROONGA_INDEX_NAME = "documents_pgroonga_v3_idx";

/**
 * Names of the indexes of previous versions, dropped by installPGroongaIndex:
 * v1 (standalone plugin) indexed documents.text, v2 indexed every previous
 * title rather than the latest ones.
 */
const LEGACY_PGROONGA_INDEX_NAMES = [
  "documents_pgroonga_idx",
  "documents_pgroonga_v2_idx",
];

/**
 * How many of a document's previous titles are indexed, the latest ones. A
 * search weighs each array element of the index separately and PGroonga
 * ignores elements beyond the weights given, so the index must hold no more
 * than the search weighs.
 */
export const MAX_PREVIOUS_TITLES = 20;

/** Names of the text extraction functions, see their definitions below. */
const NODE_TEXT_FUNCTION = "search_pgroonga_node_text";
const DOCUMENT_TEXT_FUNCTION = "search_pgroonga_document_text";

/**
 * The previous titles of a document as indexed: the latest MAX_PREVIOUS_TITLES
 * of them, as Document appends each previous title to the end of the array.
 * An empty array has no length (NULL), which GREATEST ignores.
 */
const PREVIOUS_TITLES_EXPRESSION = `(COALESCE("previousTitles", '{}')::text[])[GREATEST(array_length(COALESCE("previousTitles", '{}')::text[], 1) - ${MAX_PREVIOUS_TITLES - 1}, 1):]`;

/**
 * The indexed expression: [title, body, ...latest previous titles]. PostgreSQL
 * only uses an expression index when a query repeats the expression it was
 * built from, so the search provider embeds this very string in its queries.
 *
 * The body comes from content, which the editor saves every few seconds,
 * rather than text, which Outline only rewrites once the document is closed or
 * has not been edited for 5 minutes. A document without content falls back to
 * text.
 */
export const PGROONGA_INDEXED_EXPRESSION = `ARRAY[title::text, COALESCE(${DOCUMENT_TEXT_FUNCTION}(content), text)] || ${PREVIOUS_TITLES_EXPRESSION}`;

/**
 * Plain text of a node of documents.content. Inline content (a paragraph, a
 * heading…) is joined as is, so that a word split by formatting stays one
 * word, and blocks are separated by line breaks. The file name of an
 * attachment and the alt text (caption) of an image are included, set apart by
 * line breaks as an image sits inside a paragraph.
 *
 * The node names and attributes assumed here (text, mention with attrs.type
 * and attrs.label, br, attachment with attrs.title, image with attrs.alt) are
 * those of shared/editor.
 *
 * These functions are part of the index definition: changing what they return
 * requires rebuilding the index.
 */
const NODE_TEXT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION ${NODE_TEXT_FUNCTION}(node jsonb)
  RETURNS text
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path FROM CURRENT
AS $$
DECLARE
  children jsonb := node -> 'content';
  separator text;
BEGIN
  CASE node ->> 'type'
    WHEN 'text' THEN
      RETURN COALESCE(node ->> 'text', '');
    WHEN 'mention' THEN
      RETURN CASE WHEN node #>> '{attrs,type}' = 'user' THEN '@' ELSE '' END
        || COALESCE(node #>> '{attrs,label}', '');
    WHEN 'br' THEN
      RETURN E'\\n';
    WHEN 'attachment' THEN
      RETURN COALESCE(node #>> '{attrs,title}', '');
    WHEN 'image' THEN
      RETURN E'\\n' || COALESCE(node #>> '{attrs,alt}', '') || E'\\n';
    ELSE
      NULL;
  END CASE;

  IF jsonb_typeof(children) IS DISTINCT FROM 'array' THEN
    RETURN '';
  END IF;

  separator := CASE
    WHEN jsonb_path_exists(children, '$[*] ? (@.type == "text" || @.type == "mention")')
    THEN ''
    ELSE E'\\n'
  END;

  RETURN COALESCE(
    (SELECT string_agg(${NODE_TEXT_FUNCTION}(child), separator ORDER BY position)
     FROM jsonb_array_elements(children) WITH ORDINALITY AS c(child, position)),
    '');
END;
$$`;

/**
 * The searchable body of a document: the text of documents.content, followed
 * by the targets of its links, which documents.text (Markdown) also contains.
 */
const DOCUMENT_TEXT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION ${DOCUMENT_TEXT_FUNCTION}(content jsonb)
  RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path FROM CURRENT
AS $$
  SELECT concat_ws(
    E'\\n',
    ${NODE_TEXT_FUNCTION}(content),
    (SELECT string_agg(href #>> '{}', E'\\n')
     FROM jsonb_path_query(content, 'strict $.**.href') AS href)
  )
$$`;

/**
 * The index itself.
 *
 * tokenizer:  bigrams for every script, so both 日本語 and English match on any
 *             substring.
 * normalizer: NFKC + case folding, so ＡＢＣ = abc = ABC and ｶﾅ = カナ. Use
 *             NormalizerNFKC150("unify_kana", true) instead to also treat
 *             ひらがな and カタカナ as the same.
 *
 * @param concurrently whether to build the index without blocking writes.
 * @returns the CREATE INDEX statement.
 */
function createIndexSql(concurrently: boolean) {
  return `
CREATE INDEX ${concurrently ? "CONCURRENTLY " : ""}IF NOT EXISTS ${PGROONGA_INDEX_NAME}
  ON documents
  USING pgroonga ((${PGROONGA_INDEXED_EXPRESSION}))
  WITH (
    tokenizer = 'TokenNgram("unify_alphabet", false, "unify_digit", false, "unify_symbol", false)',
    normalizers = 'NormalizerNFKC150'
  )`;
}

/**
 * The DROP INDEX statement of an index.
 *
 * @param name the name of the index.
 * @param concurrently whether to drop the index without blocking writes.
 * @returns the DROP INDEX statement.
 */
function dropIndexSql(name: string, concurrently: boolean) {
  return `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}IF EXISTS ${name}`;
}

interface IndexOptions {
  /**
   * Whether to create or drop the index without blocking writes, the default.
   * A concurrent build cannot run inside a transaction, so this must be false
   * when a transaction is given.
   */
  concurrently?: boolean;
  /** The transaction to run in, only without `concurrently`. */
  transaction?: Transaction;
  /** Receives a line of progress per step. */
  log?: (message: string) => void;
}

/**
 * Whether the PGroonga extension is installed on the PostgreSQL server, so that
 * `CREATE EXTENSION pgroonga` could succeed.
 *
 * @param db the database connection.
 * @returns true if the extension is available.
 */
export async function isPGroongaAvailable(db: Sequelize): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'pgroonga'`,
    { type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

/**
 * State of an index in the catalog.
 *
 * @param db the database connection.
 * @param name the name of the index.
 * @param transaction the transaction to run in, if any.
 * @returns "valid", "invalid" (left behind by an interrupted concurrent build)
 * or "missing".
 */
async function getIndexState(
  db: Sequelize,
  name: string,
  transaction?: Transaction
): Promise<"valid" | "invalid" | "missing"> {
  const rows = await db.query<{ indisvalid: boolean }>(
    `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = :name`,
    { replacements: { name }, type: QueryTypes.SELECT, transaction }
  );

  if (!rows.length) {
    return "missing";
  }
  return rows[0].indisvalid ? "valid" : "invalid";
}

/**
 * Whether the PGroonga index exists and is usable.
 *
 * @param db the database connection.
 * @returns true if the index is valid.
 */
export async function hasPGroongaIndex(db: Sequelize): Promise<boolean> {
  return (await getIndexState(db, PGROONGA_INDEX_NAME)) === "valid";
}

/**
 * Creates the PGroonga extension, the text extraction functions and the index.
 * Safe to re-run: existing objects are kept, an invalid index left behind by an
 * interrupted build is rebuilt, and the indexes of previous versions are
 * dropped.
 *
 * Creating the extension requires a superuser unless it already exists.
 *
 * @param db the database connection.
 * @param options see IndexOptions.
 * @throws if PGroonga is not installed on the server or the role lacks the
 * privileges.
 */
export async function installPGroongaIndex(
  db: Sequelize,
  { concurrently = true, transaction, log = () => {} }: IndexOptions = {}
): Promise<void> {
  const run = (sql: string) => db.query(sql, { transaction });

  log("Creating the pgroonga extension if needed…");
  await run(`CREATE EXTENSION IF NOT EXISTS pgroonga`);

  log("Creating the text extraction functions…");
  await run(NODE_TEXT_FUNCTION_SQL);
  await run(DOCUMENT_TEXT_FUNCTION_SQL);

  const state = await getIndexState(db, PGROONGA_INDEX_NAME, transaction);
  if (state === "invalid") {
    log(
      `Dropping the invalid index ${PGROONGA_INDEX_NAME} left by an interrupted build…`
    );
    await run(dropIndexSql(PGROONGA_INDEX_NAME, concurrently));
  }

  if (state === "valid") {
    log(`The index ${PGROONGA_INDEX_NAME} already exists.`);
  } else {
    log(`Building the index ${PGROONGA_INDEX_NAME}, this may take a while…`);
    await run(createIndexSql(concurrently));
  }

  for (const name of LEGACY_PGROONGA_INDEX_NAMES) {
    if ((await getIndexState(db, name, transaction)) === "missing") {
      continue;
    }
    log(`Dropping the index ${name} of a previous plugin version…`);
    await run(dropIndexSql(name, concurrently));
  }
}

/**
 * Drops the PGroonga index and the text extraction functions. The extension is
 * kept, as other objects may use it.
 *
 * @param db the database connection.
 * @param options see IndexOptions.
 */
export async function uninstallPGroongaIndex(
  db: Sequelize,
  { concurrently = true, transaction, log = () => {} }: IndexOptions = {}
): Promise<void> {
  const run = (sql: string) => db.query(sql, { transaction });

  log("Dropping the indexes…");
  for (const name of [PGROONGA_INDEX_NAME, ...LEGACY_PGROONGA_INDEX_NAMES]) {
    await run(dropIndexSql(name, concurrently));
  }

  log("Dropping the text extraction functions…");
  await run(`DROP FUNCTION IF EXISTS ${DOCUMENT_TEXT_FUNCTION}(jsonb)`);
  await run(`DROP FUNCTION IF EXISTS ${NODE_TEXT_FUNCTION}(jsonb)`);
}
