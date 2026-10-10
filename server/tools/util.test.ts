import { CollectionPermission, type NavigationNode } from "@shared/types";
import {
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import {
  buildBreadcrumb,
  getBreadcrumbsForDocuments,
  optionalString,
  paginateText,
  success,
} from "./util";

const node = (
  id: string,
  title: string,
  children: NavigationNode[] = []
): NavigationNode => ({
  id,
  title,
  url: `/doc/${id}`,
  children,
});

describe("success", () => {
  it("returns a text block for empty list results", () => {
    expect(success([])).toEqual({
      content: [{ type: "text", text: "[]" }],
    });
  });

  it("returns one text block per list item", () => {
    expect(success([{ id: "a" }, { id: "b" }])).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ id: "a" }) },
        { type: "text", text: JSON.stringify({ id: "b" }) },
      ],
    });
  });

  it("wraps a single object in one text block", () => {
    expect(success({ success: true })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ success: true }) }],
    });
  });
});

describe("paginateText", () => {
  it("returns the whole text when it fits within the limit", () => {
    expect(paginateText("short text")).toEqual({
      text: "short text",
      textLength: 10,
      truncated: false,
    });
  });

  it("ends a truncated page just after the last newline", () => {
    expect(paginateText("aaa\nbbb\nccc", { limit: 9 })).toEqual({
      text: "aaa\nbbb\n",
      textLength: 11,
      truncated: true,
      nextOffset: 8,
    });
  });

  it("reassembles the full text across pages", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join("\n\n");
    let assembled = "";
    let offset: number | undefined = 0;

    while (offset !== undefined) {
      const page = paginateText(text, { offset, limit: 30 });
      expect(page.text.length).toBeLessThanOrEqual(30);
      assembled += page.text;
      offset = page.nextOffset;
    }

    expect(assembled).toEqual(text);
  });

  it("cuts a line longer than the limit without splitting a surrogate pair", () => {
    const page = paginateText("abc😀def", { limit: 4 });
    expect(page.text).toEqual("abc");
    expect(page.nextOffset).toEqual(3);
  });

  it("returns empty text when the offset is past the end", () => {
    expect(paginateText("abc", { offset: 10 })).toEqual({
      text: "",
      textLength: 3,
      truncated: false,
    });
  });
});

describe("buildBreadcrumb", () => {
  const structure: NavigationNode[] = [
    node("a", "Onboarding", [
      node("b", "Setup guide", [node("c", "Database")]),
      node("d", "Glossary"),
    ]),
    node("e", "Architecture"),
  ];

  it("returns just the collection name for a root-level document", () => {
    expect(buildBreadcrumb("a", structure, "Engineering")).toBe("Engineering");
    expect(buildBreadcrumb("e", structure, "Engineering")).toBe("Engineering");
  });

  it("includes ancestor titles for a nested document", () => {
    expect(buildBreadcrumb("b", structure, "Engineering")).toBe(
      "Engineering › Onboarding"
    );
    expect(buildBreadcrumb("c", structure, "Engineering")).toBe(
      "Engineering › Onboarding › Setup guide"
    );
  });

  it("excludes the document's own title from the path", () => {
    const result = buildBreadcrumb("c", structure, "Engineering");
    expect(result).not.toContain("Database");
  });

  it("falls back to the collection name when the document is not in the structure", () => {
    expect(buildBreadcrumb("missing", structure, "Engineering")).toBe(
      "Engineering"
    );
  });

  it("returns just the collection name when the structure is null", () => {
    expect(buildBreadcrumb("a", null, "Engineering")).toBe("Engineering");
    expect(buildBreadcrumb("a", undefined, "Engineering")).toBe("Engineering");
  });

  it("returns just the collection name when the structure is empty", () => {
    expect(buildBreadcrumb("a", [], "Engineering")).toBe("Engineering");
  });
});

describe("optionalString", () => {
  const schema = optionalString();

  it("returns undefined when input is omitted", () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("coerces an empty string to undefined", () => {
    expect(schema.parse("")).toBeUndefined();
  });

  it("passes through a non-empty string", () => {
    expect(schema.parse("hello")).toBe("hello");
  });

  it("preserves whitespace-only strings", () => {
    expect(schema.parse(" ")).toBe(" ");
  });
});

describe("getBreadcrumbsForDocuments", () => {
  it("returns the collection name for a root-level document", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Engineering",
    });
    const doc = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
    });

    const result = await getBreadcrumbsForDocuments([doc], user);
    expect(result.get(doc.id)).toBe("Engineering");
  });

  it("includes ancestor titles for a nested document", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Engineering",
    });
    const parent = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
      title: "Onboarding",
    });
    const child = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
      parentDocumentId: parent.id,
    });

    const result = await getBreadcrumbsForDocuments([child], user);
    expect(result.get(child.id)).toBe("Engineering › Onboarding");
  });

  it("omits documents whose collection the user cannot read", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: null,
      name: "Secrets",
    });
    const doc = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
    });

    const result = await getBreadcrumbsForDocuments([doc], user);
    expect(result.has(doc.id)).toBe(false);
  });

  it("returns an empty map for empty input", async () => {
    const user = await buildUser();
    const result = await getBreadcrumbsForDocuments([], user);
    expect(result.size).toBe(0);
  });

  it("omits documents that have no collection", async () => {
    const user = await buildUser();
    const result = await getBreadcrumbsForDocuments(
      [{ id: "doc-without-collection", collectionId: null }],
      user
    );
    expect(result.has("doc-without-collection")).toBe(false);
  });

  it("falls back to the collection name for a document missing from the structure", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Engineering",
    });

    const result = await getBreadcrumbsForDocuments(
      [{ id: "not-in-structure", collectionId: collection.id }],
      user
    );
    expect(result.get("not-in-structure")).toBe("Engineering");
  });

  it("resolves breadcrumbs across multiple collections in one call", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const c1 = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "One",
    });
    const c2 = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Two",
    });
    const d1 = await buildDocument({ teamId: team.id, collectionId: c1.id });
    const d2 = await buildDocument({ teamId: team.id, collectionId: c2.id });

    const result = await getBreadcrumbsForDocuments([d1, d2], user);
    expect(result.get(d1.id)).toBe("One");
    expect(result.get(d2.id)).toBe("Two");
  });
});
