import { matchPath } from "react-router-dom";
import { UrlHelper } from "@shared/utils/UrlHelper";
import type Collection from "~/models/Collection";
import type Document from "~/models/Document";
import {
  sharedModelPath,
  desktopify,
  matchCollectionEdit,
  matchCollectionSlug,
  matchDocumentEdit,
  matchDocumentHistory,
  matchDocumentSlug,
  updateCollectionPath,
  updateDocumentPath,
} from "./routeHelpers";

describe("#sharedDocumentPath", () => {
  it("should return share path for a document", () => {
    const shareId = "1c922644-40d8-41fe-98f9-df2b67239d45";
    const docPath = "/doc/test-DjDlkBi77t";
    expect(sharedModelPath(shareId)).toBe(
      "/s/1c922644-40d8-41fe-98f9-df2b67239d45"
    );
    expect(sharedModelPath(shareId, docPath)).toBe(
      "/s/1c922644-40d8-41fe-98f9-df2b67239d45/doc/test-DjDlkBi77t"
    );
  });
});

describe("#desktopify", () => {
  it("should replace https protocol with outline://", () => {
    expect(
      desktopify("/doc/test-DjDlkBi77t", "https://app.getoutline.com")
    ).toBe("outline://app.getoutline.com/doc/test-DjDlkBi77t");
  });

  it("should replace http protocol with outline://", () => {
    expect(desktopify("/doc/test-DjDlkBi77t", "http://localhost:3000")).toBe(
      "outline://localhost:3000/doc/test-DjDlkBi77t"
    );
  });
});

describe.each([
  ["doc", matchDocumentSlug, "documentSlug"],
  ["collection", matchCollectionSlug, "collectionSlug"],
])("slug matcher for /%s", (prefix, matcher, param) => {
  const slugOf = (slug: string) =>
    matchPath<Record<string, string>>(`/${prefix}/${slug}`, {
      path: `/${prefix}/${matcher}`,
      exact: true,
    })?.params[param];

  it.each([
    ["a slugified title followed by the urlId", "my-title-hh2laWfXjw"],
    ["the urlId alone", "hh2laWfXjw"],
    [
      "a slug generated before the title was dropped",
      "4peg44oc44k544ov44op44kw-hh2laWfXjw",
    ],
    ["a hyphen followed by the urlId", "-hh2laWfXjw"],
    ["an id", "1c922644-40d8-41fe-98f9-df2b67239d45"],
  ])("should match %s", (_name, slug) => {
    expect(slugOf(slug)).toBe(slug);
    expect(UrlHelper.SLUG_URL_REGEX.test(slug)).toBe(true);
  });

  it.each(["new", "short", "titlewithouthyphenhh2laWfXjw", "hh2laWfXjw!"])(
    "should not match %s",
    (slug) => {
      expect(slugOf(slug)).toBeUndefined();
      expect(UrlHelper.SLUG_URL_REGEX.test(slug)).toBe(false);
    }
  );
});

describe("routes below a slug without a title", () => {
  it("should match the document edit and history routes", () => {
    expect(
      matchPath("/doc/hh2laWfXjw/edit", { path: matchDocumentEdit })
    ).not.toBeNull();
    expect(
      matchPath<{ revisionId: string }>("/doc/hh2laWfXjw/history/latest", {
        path: matchDocumentHistory,
      })?.params.revisionId
    ).toBe("latest");
  });

  it("should match the collection tab and edit routes", () => {
    expect(
      matchPath<{ tab: string }>("/collection/hh2laWfXjw/recent", {
        path: `/collection/${matchCollectionSlug}/:tab?`,
        exact: true,
      })?.params.tab
    ).toBe("recent");
    expect(
      matchPath("/collection/hh2laWfXjw/overview/edit", {
        path: matchCollectionEdit,
      })
    ).not.toBeNull();
  });
});

describe("#updateDocumentPath", () => {
  it.each([
    [
      "replace a title that has changed",
      "/doc/old-title-hh2laWfXjw",
      "/doc/new-title-hh2laWfXjw",
      "/doc/new-title-hh2laWfXjw",
    ],
    [
      "drop the title from a url generated before it was dropped",
      "/doc/4peg44oc44k544ov44op44kw-hh2laWfXjw",
      "/doc/hh2laWfXjw",
      "/doc/hh2laWfXjw",
    ],
    [
      "add the title to a url with only the urlId",
      "/doc/hh2laWfXjw",
      "/doc/my-doc-hh2laWfXjw",
      "/doc/my-doc-hh2laWfXjw",
    ],
    [
      "keep the rest of a url with a title",
      "/doc/4peg44oc44k544ov44op44kw-hh2laWfXjw/history/latest",
      "/doc/hh2laWfXjw",
      "/doc/hh2laWfXjw/history/latest",
    ],
    [
      "keep the rest of a url with only the urlId",
      "/doc/hh2laWfXjw/edit",
      "/doc/my-doc-hh2laWfXjw",
      "/doc/my-doc-hh2laWfXjw/edit",
    ],
  ])("should %s", (_name, oldUrl, path, expected) => {
    expect(updateDocumentPath(oldUrl, { path } as Document)).toBe(expected);
  });
});

describe("#updateCollectionPath", () => {
  it.each([
    [
      "drop the name from a url generated before it was dropped",
      "/collection/6zql55m644og44o844og-hh2laWfXjw/recent",
      "/collection/hh2laWfXjw",
      "/collection/hh2laWfXjw/recent",
    ],
    [
      "add the name to a url with only the urlId",
      "/collection/hh2laWfXjw",
      "/collection/engineering-hh2laWfXjw",
      "/collection/engineering-hh2laWfXjw",
    ],
  ])("should %s", (_name, oldUrl, path, expected) => {
    expect(updateCollectionPath(oldUrl, { path } as Collection)).toBe(expected);
  });
});
