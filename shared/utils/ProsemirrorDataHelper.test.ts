import type { ProsemirrorData } from "../types";
import {
  ProsemirrorDataHelper,
  UnavailableMentionLabel,
} from "./ProsemirrorDataHelper";

describe("ProsemirrorDataHelper", () => {
  describe("getEmpty", () => {
    it("returns a new empty document each call", () => {
      const a = ProsemirrorDataHelper.getEmpty();
      const b = ProsemirrorDataHelper.getEmpty();
      expect(a).toEqual({
        type: "doc",
        content: [{ content: [], type: "paragraph" }],
      });
      expect(a).not.toBe(b);
    });

    it("produces data considered empty", () => {
      expect(
        ProsemirrorDataHelper.isEmpty(ProsemirrorDataHelper.getEmpty())
      ).toBe(true);
    });
  });

  describe("isEmpty", () => {
    it("returns false when the root is not a doc", () => {
      const data: ProsemirrorData = { type: "paragraph" };
      expect(ProsemirrorDataHelper.isEmpty(data)).toBe(false);
    });

    it("returns true for a doc with no content", () => {
      expect(ProsemirrorDataHelper.isEmpty({ type: "doc" })).toBe(true);
      expect(ProsemirrorDataHelper.isEmpty({ type: "doc", content: [] })).toBe(
        true
      );
    });

    it("returns true for a doc with a single empty paragraph", () => {
      const data: ProsemirrorData = {
        type: "doc",
        content: [{ type: "paragraph", content: [] }],
      };
      expect(ProsemirrorDataHelper.isEmpty(data)).toBe(true);
    });

    it("returns false when the single paragraph has content", () => {
      const data: ProsemirrorData = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      };
      expect(ProsemirrorDataHelper.isEmpty(data)).toBe(false);
    });

    it("returns false when there are multiple nodes", () => {
      const data: ProsemirrorData = {
        type: "doc",
        content: [
          { type: "paragraph", content: [] },
          { type: "paragraph", content: [] },
        ],
      };
      expect(ProsemirrorDataHelper.isEmpty(data)).toBe(false);
    });
  });

  describe("removeUnfurledMentionData", () => {
    const href = "https://gitlab.example.com/secret/p/-/issues/1";
    const mention = (attrs: Record<string, unknown>) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs }],
        },
      ],
    });

    it("removes unfurled data and resets the label to the url", () => {
      const data = mention({
        type: "issue",
        label: "Secret issue",
        href,
        unfurl: { title: "Secret issue", description: "Body" },
      });

      expect(ProsemirrorDataHelper.removeUnfurledMentionData(data)).toEqual(
        mention({ type: "issue", label: href, href })
      );
    });

    it("cleans url, pull request and project mentions", () => {
      for (const type of ["url", "pull_request", "project"]) {
        const result = ProsemirrorDataHelper.removeUnfurledMentionData(
          mention({ type, label: "Title", href, unfurl: { title: "Title" } })
        );
        expect(result).toEqual(mention({ type, label: href, href }));
      }
    });

    it("restores the url of a mention from a label that is the url", () => {
      expect(
        ProsemirrorDataHelper.removeUnfurledMentionData(
          mention({ type: "issue", label: href })
        )
      ).toEqual(mention({ type: "issue", label: href, href }));
    });

    it("replaces a label that may be a title when the url is unknown", () => {
      const result = ProsemirrorDataHelper.removeUnfurledMentionData(
        mention({ type: "issue", label: "Secret issue" })
      );
      expect(result).toEqual(
        mention({ type: "issue", label: UnavailableMentionLabel })
      );
      // Cleaning again changes nothing.
      expect(ProsemirrorDataHelper.removeUnfurledMentionData(result)).toBe(
        result
      );
    });

    it("does not use an href with an unsupported protocol as the label", () => {
      expect(
        ProsemirrorDataHelper.removeUnfurledMentionData(
          mention({ type: "url", label: "Secret", href: "javascript:alert(1)" })
        )
      ).toEqual(
        mention({
          type: "url",
          label: UnavailableMentionLabel,
          href: "javascript:alert(1)",
        })
      );
    });

    it("leaves internal mentions untouched", () => {
      const data = mention({ type: "user", label: "Jane", modelId: "1" });
      expect(ProsemirrorDataHelper.removeUnfurledMentionData(data)).toBe(data);
    });

    it("returns the same reference when there is nothing to remove", () => {
      const data = mention({ type: "issue", label: href, href });
      expect(ProsemirrorDataHelper.removeUnfurledMentionData(data)).toBe(data);

      // Nodes serialized by Prosemirror carry the attribute without a value.
      const serialized = mention({
        type: "issue",
        label: href,
        href,
        unfurl: undefined,
      });
      expect(ProsemirrorDataHelper.removeUnfurledMentionData(serialized)).toBe(
        serialized
      );
    });

    it("only copies the nodes on the path to a changed mention", () => {
      const untouched: ProsemirrorData = {
        type: "paragraph",
        content: [{ type: "text", text: "Hello" }],
      };
      const data: ProsemirrorData = {
        type: "doc",
        content: [
          untouched,
          {
            type: "paragraph",
            content: [
              {
                type: "mention",
                attrs: { type: "issue", label: "Secret", href },
              },
            ],
          },
        ],
      };

      const result = ProsemirrorDataHelper.removeUnfurledMentionData(data);
      expect(result).not.toBe(data);
      expect(result.content?.[0]).toBe(untouched);
      expect(result.content?.[1].content?.[0].attrs?.label).toBe(href);
      // The input is never mutated.
      expect(data.content?.[1].content?.[0].attrs?.label).toBe("Secret");
    });

    it("cleans mentions nested in arbitrary JSON", () => {
      const data = {
        attributes: {
          content: mention({ type: "issue", label: "Secret", href }),
        },
        previous: null,
      };
      expect(ProsemirrorDataHelper.removeUnfurledMentionData(data)).toEqual({
        attributes: {
          content: mention({ type: "issue", label: href, href }),
        },
        previous: null,
      });
    });
  });
});
