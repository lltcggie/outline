import invariant from "invariant";
import { compact, escapeRegExp, find, map } from "es-toolkit/compat";
import type { BindOrReplacements, WhereOptions } from "sequelize";
import { QueryTypes } from "sequelize";
import { DirectionFilter, SortFilter } from "@shared/types";
import { regexIndexOf, regexLastIndexOf } from "@shared/utils/string";
import Collection from "@server/models/Collection";
import type { QueryGeneratorWithWhere } from "@server/models/Document";
import Document from "@server/models/Document";
import type Team from "@server/models/Team";
import type User from "@server/models/User";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { sequelizeReadOnly } from "@server/storage/database";
import type {
  SearchOptions,
  SearchResponse,
} from "@server/utils/BaseSearchProvider";
import PostgresSearchProvider from "../../search-postgres/server/PostgresSearchProvider";
import {
  MAX_PREVIOUS_TITLES,
  PGROONGA_INDEX_NAME,
  PGROONGA_INDEXED_EXPRESSION,
  hasPGroongaIndex,
} from "./pgroongaIndex";

/**
 * Relative weight of a match in the title, the body and a previous title. The
 * proportions mirror the built-in provider (tsvector weights A, D, C).
 */
const TITLE_WEIGHT = 10;
const BODY_WEIGHT = 1;
const PREVIOUS_TITLE_WEIGHT = 2;

interface ParsedQuery {
  /** The query in Groonga query syntax. */
  groonga: string;
  /** Matches the query as typed, the best place to excerpt. */
  fullMatchRegex: RegExp;
  /** Matches the query as typed or any term that must (or may) appear. */
  highlightRegex: RegExp;
}

interface RankedRow {
  id: string;
  searchRanking: number;
  /** The number of matches before LIMIT and OFFSET, the same on every row. */
  total: string;
}

/**
 * Search provider that uses PGroonga for full-text search, so that languages
 * written without spaces between words (Japanese, Chinese, Korean…) can be
 * searched by any substring.
 *
 * Everything other than text matching and ranking is inherited from the
 * built-in PostgreSQL provider: permission scoping, filters, title search,
 * collection search and searches without a query. The PGroonga index lives in
 * the same database and is kept up to date by PostgreSQL itself, so
 * index/remove/updateMetadata stay no-ops.
 *
 * Requires the index created by `server/scripts/search-pgroonga-index.ts`, see
 * pgroongaIndex.ts.
 */
export class PGroongaSearchProvider extends PostgresSearchProvider {
  /**
   * Convert a user search query into Groonga query syntax.
   *
   * Every term is emitted as an escaped, quoted phrase so that user input can
   * never be interpreted as Groonga operators or produce a syntax error.
   * Supported on top of plain terms (which are ANDed together):
   *
   * - `"exact phrase"`
   * - `-term` or `-"phrase"` to exclude
   * - `OR` (upper case) between two terms
   *
   * Terms may be separated by any whitespace, including the full-width space.
   *
   * @param query - the user search query.
   * @returns the Groonga query and what to highlight, or undefined when the
   * query has no terms.
   */
  public static parseQuery(query: string | undefined): ParsedQuery | undefined {
    const limitedQuery = (query ?? "").slice(
      0,
      PostgresSearchProvider.maxQueryLength
    );

    type Token =
      | { type: "term"; text: string; negative: boolean }
      | { type: "or" };
    const tokens: Token[] = [];

    for (const match of limitedQuery.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
      const [, quotedMinus, phrase, bare] = match;

      if (bare === undefined) {
        if (phrase.trim()) {
          tokens.push({
            type: "term",
            text: phrase.trim(),
            negative: quotedMinus === "-",
          });
        }
        continue;
      }

      if (bare === "OR") {
        tokens.push({ type: "or" });
        continue;
      }

      const negative = bare.length > 1 && bare.startsWith("-");
      // Unbalanced quote characters carry no meaning, drop them.
      const text = (negative ? bare.slice(1) : bare).replace(/"/g, "");
      if (text) {
        tokens.push({ type: "term", text, negative });
      }
    }

    // A query of nothing but OR is a search for the word itself.
    if (tokens.length && !tokens.some((t) => t.type === "term")) {
      tokens.splice(0, tokens.length, {
        type: "term",
        text: "OR",
        negative: false,
      });
    }

    // Groonga cannot evaluate a query made only of exclusions, in that case
    // search for the words themselves.
    const hasPositive = tokens.some((t) => t.type === "term" && !t.negative);
    const parts: string[] = [];
    const terms: string[] = [];
    let pendingOr = false;

    for (const token of tokens) {
      if (token.type === "or") {
        pendingOr = parts.length > 0;
        continue;
      }

      const negative = hasPositive && token.negative;
      const quoted = `"${token.text.replace(/[\\"]/g, "\\$&")}"`;

      if (negative) {
        parts.push(`-${quoted}`);
      } else {
        parts.push(pendingOr ? `OR ${quoted}` : quoted);
        terms.push(token.text);
      }
      pendingOr = false;
    }

    // Every term that is not an exclusion is highlighted, and a query with
    // any part has at least one such term.
    if (!parts.length) {
      return undefined;
    }

    const fullMatchRegex = new RegExp(escapeRegExp(limitedQuery.trim()), "i");
    return {
      groonga: parts.join(" "),
      fullMatchRegex,
      highlightRegex: new RegExp(
        [
          fullMatchRegex.source,
          ...terms
            // longest first, so that overlapping terms highlight fully
            .sort((a, b) => b.length - a.length)
            .map((term) => escapeRegExp(term)),
        ].join("|"),
        "gi"
      ),
    };
  }

  id = "pgroonga";

  /**
   * Perform a full-text search scoped to a user's accessible documents, see
   * BaseSearchProvider. Without a query the built-in provider answers.
   *
   * @param user - the user performing the search.
   * @param options - search options.
   * @returns search results with ranking and context.
   */
  async searchForUser(
    user: User,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const parsed = PGroongaSearchProvider.parseQuery(options.query);

    // Without a query there is nothing to match or rank, the built-in provider
    // lists the documents.
    if (!parsed) {
      return super.searchForUser(user, { ...options, query: undefined });
    }

    // Permission scoping and filters come from the built-in provider. The
    // query is withheld so that it does not add its own tsvector condition.
    const where = await PGroongaSearchProvider.buildWhere(user, {
      ...options,
      query: undefined,
    });

    return this.search({
      teamId: user.teamId,
      where,
      parsed,
      options,
      usePopularityBoost: true,
      loadDocuments: (ids) =>
        Document.withMembershipScope(user.id, { includeDrafts: true }).findAll({
          where: {
            teamId: user.teamId,
            id: ids,
          },
        }),
    });
  }

  /**
   * Perform a full-text search scoped to a team, as used for shared document
   * search, see BaseSearchProvider. Without a query the built-in provider
   * answers.
   *
   * @param team - the team to search within.
   * @param options - search options.
   * @returns search results with ranking and context.
   */
  async searchForTeam(
    team: Team,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const parsed = PGroongaSearchProvider.parseQuery(options.query);

    if (!parsed) {
      return super.searchForTeam(team, { ...options, query: undefined });
    }

    const where = await PGroongaSearchProvider.buildTeamWhere(team, {
      ...options,
      query: undefined,
    });

    return this.search({
      teamId: team.id,
      where,
      parsed,
      options,
      usePopularityBoost: options.usePopularityBoost,
      loadDocuments: (ids) =>
        Document.findAll({
          where: {
            id: ids,
            teamId: team.id,
          },
          include: [
            {
              model: Collection,
              as: "collection",
            },
          ],
        }),
    });
  }

  /**
   * Finds every matching document of the team and its score using only the
   * PGroonga index, as a CTE that the ranked and count queries start with.
   *
   * PGroonga only computes a score (and only guarantees its full-text
   * semantics) when the row is found through its index. Were the text
   * condition one more condition next to the permission conditions,
   * PostgreSQL would be free to locate rows through some other index and
   * merely re-check the text, which silently zeroes the ranking. Here the
   * index is the only way in:
   *
   * - MATERIALIZED keeps the CTE a plan of its own, no condition of the outer
   *   query is pushed into it.
   * - inside it the text condition is the only indexable one, teamId is
   *   compared as text so that no b-tree index applies to it.
   * - sequential scans are disabled for the transaction, see
   *   MATCH_SETTINGS_SQL.
   *
   * The outer query is then free to filter the matches by permissions and
   * filters in any way it likes, the scores are already computed.
   */
  private static readonly MATCHES_CTE = `
    WITH matches AS MATERIALIZED (
      SELECT id AS "matchId", pgroonga_score(tableoid, ctid) AS "matchScore"
      FROM documents
      WHERE ${PGROONGA_INDEXED_EXPRESSION} &@~ pgroonga_condition(
          :query,
          weights => ARRAY[${[
            TITLE_WEIGHT,
            BODY_WEIGHT,
            ...Array<number>(MAX_PREVIOUS_TITLES).fill(PREVIOUS_TITLE_WEIGHT),
          ].join(", ")}],
          index_name => '${PGROONGA_INDEX_NAME}'
        )
        AND "teamId"::text = :teamId
    )`;

  /**
   * Joins the matches to the documents, aliased "Document" as in findAll, so
   * that a `where` written by Sequelize's query generator applies unchanged.
   */
  private static readonly FROM_MATCHES_SQL = `
    FROM documents AS "Document"
    JOIN matches ON matches."matchId" = "Document"."id"`;

  /**
   * Settings the queries built by buildMatchesSql run with, sent in the same
   * round trip as the query. SET LOCAL scopes them to the transaction the
   * query runs in, see queryMatches.
   */
  private static readonly MATCH_SETTINGS_SQL = `SET LOCAL enable_seqscan = off;`;

  /** Whether the index has been confirmed to exist, checked on first use. */
  private static indexVerified = false;

  private static readonly SNIPPET_BREAK_REGEX = new RegExp(
    `[ .,"'\n。、！？!?…　]`,
    "g"
  );

  /**
   * The total number of matches of a ranked query. The ranked query counts
   * them itself, so only a page past the end of the results, which has no row
   * to read the count from, needs a query of its own.
   *
   * @param results - the rows of the ranked query.
   * @param offset - the offset the ranked query ran with.
   * @param where - the permission-scoped conditions, as passed to findAll.
   * @param replacements - the replacements of the ranked query.
   * @returns the total.
   */
  private static async countMatches({
    results,
    offset,
    where,
    replacements,
  }: {
    results: RankedRow[];
    offset: number;
    where: WhereOptions<Document>;
    replacements: BindOrReplacements;
  }): Promise<number> {
    if (results.length > 0) {
      return Number(results[0].total);
    }
    if (offset === 0) {
      return 0;
    }

    const [row] = await PGroongaSearchProvider.queryMatches<{ count: string }>(
      PGroongaSearchProvider.buildMatchesSql({
        select: `SELECT COUNT(*) AS count`,
        where,
      }),
      replacements
    );
    return Number(row.count);
  }

  /**
   * Builds a query over the documents matching the full-text query, see
   * MATCHES_CTE, narrowed by `where`. It takes the replacements query and
   * teamId, plus any used in `tail`.
   *
   * @param select - the SELECT clause.
   * @param where - the permission-scoped conditions, as passed to findAll.
   * @param tail - ORDER BY, LIMIT and so on.
   * @returns the SQL.
   */
  private static buildMatchesSql({
    select,
    where,
    tail = "",
  }: {
    select: string;
    where: WhereOptions<Document>;
    tail?: string;
  }): string {
    // Written exactly as findAll writes the WHERE of "Document".
    const generator = sequelizeReadOnly.getQueryInterface()
      .queryGenerator as QueryGeneratorWithWhere;
    const conditions = generator.getWhereConditions(
      where,
      "Document",
      Document
    );

    return [
      PGroongaSearchProvider.MATCHES_CTE,
      select,
      PGroongaSearchProvider.FROM_MATCHES_SQL,
      conditions ? `WHERE ${conditions}` : "",
      tail,
    ].join("\n");
  }

  /**
   * Builds the ranked, paginated query of a search with a query. It takes the
   * replacements query, teamId, limit and offset.
   *
   * @param where - the permission-scoped conditions, as passed to findAll.
   * @param sort - the requested sort, if any.
   * @param direction - the requested direction, if any.
   * @param usePopularityBoost - whether popular documents rank higher.
   * @returns the SQL, selecting the columns of RankedRow.
   */
  private static buildRankedSql({
    where,
    sort,
    direction,
    usePopularityBoost,
  }: {
    where: WhereOptions<Document>;
    sort?: SortFilter;
    direction?: DirectionFilter;
    usePopularityBoost: boolean;
  }): string {
    const rank = usePopularityBoost
      ? `matches."matchScore" * (1 + 0.25 * LN(1 + COALESCE("Document"."popularityScore", 0)))`
      : `matches."matchScore"`;

    // Every row is read to sort them anyway, so counting them in the same
    // query is nearly free and spares the count query a second index scan.
    return PGroongaSearchProvider.buildMatchesSql({
      select: `SELECT "Document"."id", ${rank} AS "searchRanking", COUNT(*) OVER () AS "total"`,
      where,
      tail: `ORDER BY ${PGroongaSearchProvider.buildRankedOrder(
        sort,
        direction
      )} LIMIT :limit OFFSET :offset`,
    });
  }

  /**
   * Runs a query built by buildMatchesSql (or an EXPLAIN of one) in a
   * read-only transaction, preceded by MATCH_SETTINGS_SQL in the same round
   * trip. Replacements are written into the SQL before it is sent, so the two
   * statements travel as one simple query and only the rows of the last one
   * are returned.
   *
   * @param sql - the query.
   * @param replacements - its replacements.
   * @returns the rows.
   */
  private static async queryMatches<T extends object>(
    sql: string,
    replacements: BindOrReplacements
  ): Promise<T[]> {
    await PGroongaSearchProvider.verifyIndex();

    return sequelizeReadOnly.transaction((transaction) =>
      sequelizeReadOnly.query<T>(
        `${PGroongaSearchProvider.MATCH_SETTINGS_SQL}\n${sql}`,
        {
          replacements,
          type: QueryTypes.SELECT,
          transaction,
        }
      )
    );
  }

  /**
   * Fails loudly when the index is missing or unusable. Without it PostgreSQL
   * would still answer, slowly and with every score at zero, which is much
   * harder to notice than an error.
   */
  private static async verifyIndex() {
    if (PGroongaSearchProvider.indexVerified) {
      return;
    }

    if (!(await hasPGroongaIndex(sequelizeReadOnly))) {
      throw new Error(
        `SEARCH_PROVIDER is "pgroonga" but the index "${PGROONGA_INDEX_NAME}" does not exist or is invalid. Run "node build/server/scripts/search-pgroonga-index.js install" against the database, or wait for it to finish if it is still running.`
      );
    }
    PGroongaSearchProvider.indexVerified = true;
  }

  /**
   * The ORDER BY of a search with a query, as the built-in buildFindOptions
   * orders one.
   *
   * @param sort - the requested sort, if any.
   * @param direction - the requested direction, if any.
   * @returns the ORDER BY expressions.
   */
  private static buildRankedOrder(
    sort?: SortFilter,
    direction?: DirectionFilter
  ): string {
    // When searching with a query and no explicit sort, prioritize search
    // ranking as the primary sort criterion. Otherwise, use the specified sort
    // with ranking as a tiebreaker.
    if (!sort) {
      return `"searchRanking" DESC, "Document"."updatedAt" DESC`;
    }

    const sortDirection = direction ?? DirectionFilter.DESC;

    // Both are written into the SQL, so only known values get through.
    invariant(
      Object.values(SortFilter).includes(sort),
      `Invalid sort: ${sort}`
    );
    invariant(
      Object.values(DirectionFilter).includes(sortDirection),
      `Invalid direction: ${sortDirection}`
    );

    const sortExpression =
      sort === SortFilter.Title
        ? `LOWER("Document"."title")`
        : `"Document"."${sort}"`;

    return `${sortExpression} ${sortDirection}, "searchRanking" DESC`;
  }

  /**
   * Build a snippet of text around the first match with every term wrapped in
   * <b> tags. Unlike the built-in provider this does not rely on word
   * boundaries, which do not exist in Japanese text.
   *
   * @param document - the matched document.
   * @param parsed - the parsed query.
   * @returns the snippet.
   */
  private static buildSnippet(
    document: Document,
    { fullMatchRegex, highlightRegex }: ParsedQuery
  ): string {
    const text = DocumentHelper.toPlainText(document);
    const breakCharsRegex = PGroongaSearchProvider.SNIPPET_BREAK_REGEX;

    // Excerpt around the first match, preferring a match of the whole query.
    const fullMatchIndex = text.search(fullMatchRegex);
    const matchIndex =
      fullMatchIndex >= 0 ? fullMatchIndex : text.search(highlightRegex);
    const offsetStartIndex = matchIndex - 65;
    // Start on a break character shortly before the match when there is one,
    // otherwise (common in Japanese) simply a fixed distance before it.
    const breakStartIndex =
      offsetStartIndex <= 0
        ? 0
        : regexIndexOf(text, breakCharsRegex, offsetStartIndex);
    const startIndex =
      breakStartIndex >= 0 && breakStartIndex <= matchIndex
        ? breakStartIndex
        : Math.max(0, offsetStartIndex);

    // End on the last break character within the window, unless the window
    // reaches the end of the text or that would cut the match off.
    const maxEndIndex = Math.min(text.length, startIndex + 250);
    const breakIndex =
      maxEndIndex === text.length
        ? maxEndIndex
        : regexLastIndexOf(text, breakCharsRegex, maxEndIndex);
    const endIndex =
      breakIndex > Math.max(startIndex, matchIndex + 20)
        ? breakIndex
        : maxEndIndex;

    // Highlight after slicing, as the inserted tags shift every index that
    // follows an earlier match.
    return text
      .slice(startIndex, endIndex)
      .replace(highlightRegex, "<b>$&</b>");
  }

  /**
   * Shared tail of searchForUser and searchForTeam: narrows an already
   * permission-scoped `where` to the documents matching the query, then ranks,
   * paginates and counts them the same way the built-in provider does.
   */
  private async search({
    teamId,
    where,
    parsed,
    options,
    usePopularityBoost = true,
    loadDocuments,
  }: {
    teamId: string;
    where: WhereOptions<Document>;
    parsed: ParsedQuery;
    options: SearchOptions;
    usePopularityBoost?: boolean;
    loadDocuments: (ids: string[]) => Promise<Document[]>;
  }): Promise<SearchResponse> {
    const { limit = 15, offset = 0 } = options;
    const replacements = { query: parsed.groonga, teamId };

    const results = await PGroongaSearchProvider.queryMatches<RankedRow>(
      PGroongaSearchProvider.buildRankedSql({
        where,
        sort: options.sort,
        direction: options.direction,
        usePopularityBoost,
      }),
      { ...replacements, limit, offset }
    );

    const [documents, count] = await Promise.all([
      loadDocuments(map(results, "id")),
      PGroongaSearchProvider.countMatches({
        results,
        offset,
        where,
        replacements,
      }),
    ]);

    return {
      results: compact(
        map(results, (result) => {
          const document = find(documents, {
            id: result.id,
          });

          // The ranked query may run on a read replica, so a document can be
          // returned that has since been removed on the primary.
          if (!document) {
            return null;
          }

          return {
            ranking: Number(result.searchRanking),
            context: PGroongaSearchProvider.buildSnippet(document, parsed),
            document,
          };
        })
      ),
      total: count,
    };
  }
}
