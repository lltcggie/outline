import { randomUUID } from "node:crypto";
import type { QueryInterface } from "sequelize";
import type { NavigationNode } from "@shared/types";
import { getIsolatedCollectionsTable } from "@server/test/support";
import { flattenTree } from "@shared/utils/tree";
import slugify from "@server/utils/slugify";
// @ts-expect-error migrations are plain JavaScript without type declarations.
import untypedMigration from "../../migrations/20261120120000-remove-unreadable-slugs-from-document-structure.js";

// This test lives outside server/migrations because sequelize-cli runs every
// file in that directory as a migration.
const migration = untypedMigration as {
  up: (queryInterface: QueryInterface) => Promise<void>;
  down: (queryInterface: QueryInterface) => Promise<void>;
};

// The migration rewrites every collection, so it runs against a table of its
// own rather than the one shared with tests that run at the same time.
const { queryInterface, insert, read } = getIsolatedCollectionsTable();

const node = (
  title: string,
  url: string,
  children: NavigationNode[] = []
): NavigationNode => ({ id: randomUUID(), title, url, children });

/** The url a document had before unreadable slugs were dropped. */
const previousUrl = (title: string, urlId: string) =>
  `/doc/${slugify(title)}-${urlId}`;

const flatten = (nodes: NavigationNode[] | null) =>
  (nodes ?? []).flatMap(flattenTree);

const urls = (nodes: NavigationNode[] | null) =>
  flatten(nodes).map((item) => item.url);

describe("remove-unreadable-slugs-from-document-structure", () => {
  const structure = () => [
    node("テスト用ページ", previousUrl("テスト用ページ", "aaaaaaaaaa"), [
      node("子ページ？", previousUrl("子ページ？", "bbbbbbbbbb")),
      node("Getting Started", previousUrl("Getting Started", "cccccccccc")),
    ]),
    node("会議のメモ 2026", previousUrl("会議のメモ 2026", "dddddddddd")),
    node("设计文档", previousUrl("设计文档", "eeeeeeeeee")),
    node("🎉", previousUrl("🎉", "ffffffffff")),
    node("", "/doc/untitled-gggggggggg"),
  ];

  it("should remove only the slugs that are the base64 of the title", async () => {
    const id = await insert(structure());

    await migration.up(queryInterface);

    expect(urls((await read(id)).documentStructure)).toEqual([
      "/doc/aaaaaaaaaa",
      "/doc/bbbbbbbbbb",
      "/doc/getting-started-cccccccccc",
      "/doc/2026-dddddddddd",
      "/doc/she-ji-wen-dang-eeeeeeeeee",
      "/doc/ffffffffff",
      "/doc/untitled-gggggggggg",
    ]);
  });

  it("should leave a slug that does not come from the title", async () => {
    const documentStructure = [
      node("テスト用ページ", "/doc/44og44k544oi-aaaaaaaaaa"),
      node("Renamed", previousUrl("テスト用ページ", "bbbbbbbbbb")),
    ];
    const id = await insert(documentStructure);

    await migration.up(queryInterface);

    expect(urls((await read(id)).documentStructure)).toEqual(
      urls(documentStructure)
    );
  });

  it("should not change other fields or the timestamp", async () => {
    const documentStructure = structure();
    const id = await insert(documentStructure);
    const before = await read(id);

    await migration.up(queryInterface);

    const after = await read(id);
    const withoutUrls = (nodes: NavigationNode[] | null) =>
      flatten(nodes).map(({ url: _url, children, ...rest }) => ({
        ...rest,
        children: children.map((child) => child.id),
      }));
    expect(withoutUrls(after.documentStructure)).toEqual(
      withoutUrls(documentStructure)
    );
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("should tolerate collections without a structure", async () => {
    const id = await insert(null);

    await migration.up(queryInterface);

    expect((await read(id)).documentStructure).toBeNull();
  });

  it("should put the slugs back when reverted", async () => {
    const id = await insert(structure());

    await migration.up(queryInterface);
    await migration.down(queryInterface);

    expect(urls((await read(id)).documentStructure)).toEqual(urls(structure()));
  });

  it("should give every url that is only a urlId a slug when reverted", async () => {
    const id = await insert([
      node("Getting Started", "/doc/aaaaaaaaaa"),
      node("テスト用ページ", "/doc/bbbbbbbbbb"),
    ]);

    await migration.down(queryInterface);

    // Urls without a title cannot be opened by upstream, whatever the title.
    expect(urls((await read(id)).documentStructure)).toEqual([
      "/doc/r2v0dgluzybtdgfydgvk-aaaaaaaaaa",
      "/doc/44og44k544oi55so44oa44o844k4-bbbbbbbbbb",
    ]);
  });
});
