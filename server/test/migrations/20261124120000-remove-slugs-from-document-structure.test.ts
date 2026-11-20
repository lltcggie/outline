import { randomUUID } from "node:crypto";
import type { QueryInterface } from "sequelize";
import type { NavigationNode } from "@shared/types";
import { Document } from "@server/models";
import { getIsolatedCollectionsTable } from "@server/test/support";
import { flattenTree } from "@shared/utils/tree";
// @ts-expect-error migrations are plain JavaScript without type declarations.
import untypedMigration from "../../migrations/20261124120000-remove-slugs-from-document-structure.js";

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

const flatten = (nodes: NavigationNode[] | null) =>
  (nodes ?? []).flatMap(flattenTree);

const urls = (nodes: NavigationNode[] | null) =>
  flatten(nodes).map((item) => item.url);

describe("remove-slugs-from-document-structure", () => {
  const structure = () => [
    node("Live Params", "/doc/liveparams-aaaaaaaaaa", [
      node("Getting Started", "/doc/getting-started-bbbbbbbbbb"),
      node("テスト用ページ", "/doc/cccccccccc"),
    ]),
    node("设计文档", "/doc/she-ji-wen-dang-dddddddddd"),
    node("", "/doc/untitled-eeeeeeeeee"),
    node("Renamed since", "/doc/44og44k544oi-ffffffffff"),
    node("a_b~c", "/doc/a_b~c-gggggggggg"),
  ];

  it("should leave only the urlId in every url", async () => {
    const id = await insert(structure());

    await migration.up(queryInterface);

    const migrated = (await read(id)).documentStructure;
    expect(urls(migrated)).toEqual([
      "/doc/aaaaaaaaaa",
      "/doc/bbbbbbbbbb",
      "/doc/cccccccccc",
      "/doc/dddddddddd",
      "/doc/eeeeeeeeee",
      "/doc/ffffffffff",
      "/doc/gggggggggg",
    ]);

    // The urls agree with the ones that documents now have.
    expect(urls(migrated)).toEqual(
      flatten(migrated).map((item) =>
        Document.getPath({ title: item.title, urlId: item.url.slice(-10) })
      )
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

  it("should rewrite collections beyond the first batch", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      ids.push(await insert([node("Page", "/doc/page-aaaaaaaaaa")]));
    }

    await migration.up(queryInterface);

    for (const id of ids) {
      expect(urls((await read(id)).documentStructure)).toEqual([
        "/doc/aaaaaaaaaa",
      ]);
    }
  });

  it("should tolerate collections without a structure", async () => {
    const id = await insert(null);

    await migration.up(queryInterface);

    expect((await read(id)).documentStructure).toBeNull();
  });

  it("should leave the urls as they are when reverted", async () => {
    const id = await insert(structure());

    await migration.up(queryInterface);
    const migrated = (await read(id)).documentStructure;
    await migration.down(queryInterface);

    expect((await read(id)).documentStructure).toEqual(migrated);
  });
});
