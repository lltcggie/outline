import { DOMParser, type Node as ProsemirrorNode } from "prosemirror-model";
import { MentionType } from "../../types";
import { parser, schema, serializer } from "../../test/editor";
import { UnavailableMentionLabel } from "../../utils/ProsemirrorDataHelper";

const id = "0c440212-8b40-49fa-8a64-2548d6b60d59";
const modelId = "c85a0d80-3a89-4b25-a0cd-e7fc83f0d226";

/**
 * Parses an HTML string with the editor schema, in the same way as pasted
 * content, and returns the attributes of the first mention.
 */
const parseMentionHTML = (html: string) => {
  const element = document.createElement("div");
  element.innerHTML = html;
  const doc = DOMParser.fromSchema(schema).parse(element);
  let mention: ProsemirrorNode | undefined;
  doc.descendants((node) => {
    if (node.type.name === "mention" && !mention) {
      mention = node;
    }
    return !mention;
  });
  return mention?.attrs;
};

// Shared tests run in both node and jsdom; parsing HTML requires a DOM.
describe.runIf(typeof document !== "undefined")("Mention parsing", () => {
  const href = "https://gitlab.example.com/secret/p/-/issues/1";

  // jsdom does not implement innerText, which the mention reads its label from.
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent;
      },
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "innerText");
  });

  it("never keeps the title of an external mention pasted as HTML", () => {
    const attrs = parseMentionHTML(
      `<a class="mention" data-type="${MentionType.Issue}" data-id="${modelId}" href="${href}">Secret issue title</a>`
    );
    expect(attrs?.label).toBe(href);
    expect(attrs?.href).toBe(href);
  });

  it("restores the url of an external mention from a label that is the url", () => {
    const attrs = parseMentionHTML(
      `<a class="mention" data-type="${MentionType.Issue}" data-id="${modelId}">${href}</a>`
    );
    expect(attrs?.label).toBe(href);
    expect(attrs?.href).toBe(href);
  });

  it("replaces the label of an external mention without a url", () => {
    const attrs = parseMentionHTML(
      `<span class="mention" data-type="${MentionType.Issue}" data-id="${modelId}">Secret issue title</span>`
    );
    expect(attrs?.label).toBe(UnavailableMentionLabel);
  });

  it("keeps the label of an internal mention", () => {
    const attrs = parseMentionHTML(
      `<span class="mention" data-type="${MentionType.User}" data-id="${modelId}">Jane</span>`
    );
    expect(attrs?.label).toBe("Jane");
  });
});

const serializeMention = (
  attrs: Record<string, unknown>,
  options?: { commonMark?: boolean }
) => {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "mention", attrs: { id, modelId, ...attrs } }],
      },
    ],
  });
  return serializer.serialize(doc, options).trim();
};

describe("Mention serialization", () => {
  describe("markdown leaving Outline", () => {
    it("serializes an issue mention as an @ prefixed link showing only the url", () => {
      expect(
        serializeMention(
          {
            type: MentionType.Issue,
            label: "Epic 1: Control plane Helm chart",
            href: "https://github.com/acme/infra/issues/2",
          },
          { commonMark: true }
        )
      ).toBe(
        "@[https://github.com/acme/infra/issues/2](https://github.com/acme/infra/issues/2)"
      );
    });

    it("serializes a pull request mention as an @ prefixed link showing only the url", () => {
      expect(
        serializeMention(
          {
            type: MentionType.PullRequest,
            label: "Add Helm chart",
            href: "https://github.com/acme/infra/pull/42",
          },
          { commonMark: true }
        )
      ).toBe(
        "@[https://github.com/acme/infra/pull/42](https://github.com/acme/infra/pull/42)"
      );
    });

    it("serializes a project mention as an @ prefixed link showing only the url", () => {
      expect(
        serializeMention(
          {
            type: MentionType.Project,
            label: "Q3 Roadmap",
            href: "https://github.com/orgs/acme/projects/7",
          },
          { commonMark: true }
        )
      ).toBe(
        "@[https://github.com/orgs/acme/projects/7](https://github.com/orgs/acme/projects/7)"
      );
    });

    it("serializes a url mention as an @ prefixed link", () => {
      expect(
        serializeMention(
          {
            type: MentionType.URL,
            label: "Example",
            href: "https://example.com/page",
          },
          { commonMark: true }
        )
      ).toBe("@[https://example.com/page](https://example.com/page)");
    });

    it("sanitizes an unsafe url", () => {
      const markdown = serializeMention(
        {
          type: MentionType.Issue,
          label: "Epic 1",
          // oxlint-disable-next-line no-script-url
          href: "javascript:alert(1)",
        },
        { commonMark: true }
      );
      expect(markdown).not.toContain("(javascript:");
    });

    it("keeps the mention:// format when there is no url to link to", () => {
      // The label may be the title of the resource, so it is not written.
      expect(
        serializeMention(
          { type: MentionType.Issue, label: "Epic 1" },
          { commonMark: true }
        )
      ).toBe(`@[${UnavailableMentionLabel}](mention://${id}/issue/${modelId})`);
    });

    it("keeps the mention:// format for internal mentions", () => {
      expect(
        serializeMention(
          { type: MentionType.User, label: "John Doe" },
          { commonMark: true }
        )
      ).toBe(`@[John Doe](mention://${id}/user/${modelId})`);
    });
  });

  describe("markdown staying within Outline", () => {
    it("keeps the mention:// format for an issue mention without its title", () => {
      expect(
        serializeMention({
          type: MentionType.Issue,
          label: "Epic 1: Control plane Helm chart",
          href: "https://github.com/acme/infra/issues/2",
        })
      ).toBe(
        `@[https://github.com/acme/infra/issues/2](mention://${id}/issue/${modelId}?href=https%3A%2F%2Fgithub.com%2Facme%2Finfra%2Fissues%2F2)`
      );
    });

    it("keeps the mention:// format for a pull request mention", () => {
      expect(
        serializeMention({
          type: MentionType.PullRequest,
          label: "Add Helm chart",
          href: "https://github.com/acme/infra/pull/42",
        })
      ).toBe(
        `@[https://github.com/acme/infra/pull/42](mention://${id}/pull_request/${modelId}?href=https%3A%2F%2Fgithub.com%2Facme%2Finfra%2Fpull%2F42)`
      );
    });

    it("keeps the mention:// format for a project mention", () => {
      expect(
        serializeMention({
          type: MentionType.Project,
          label: "Q3 Roadmap",
          href: "https://github.com/orgs/acme/projects/7",
        })
      ).toBe(
        `@[https://github.com/orgs/acme/projects/7](mention://${id}/project/${modelId}?href=https%3A%2F%2Fgithub.com%2Forgs%2Facme%2Fprojects%2F7)`
      );
    });

    it("round-trips the type, ids and url of an external mention", () => {
      const href = "https://gitlab.example.com/g/p/-/issues/1?a=1&b=(2)";
      const markdown = serializeMention({
        type: MentionType.Issue,
        label: href,
        href,
      });

      let mention: ProsemirrorNode | undefined;
      parser.parse(markdown)?.descendants((node) => {
        mention ??= node.type.name === "mention" ? node : undefined;
      });
      expect(mention?.attrs).toMatchObject({
        id,
        modelId,
        type: MentionType.Issue,
        href,
        label: href,
      });
    });

    it("does not write an url for internal mentions", () => {
      expect(
        serializeMention({
          type: MentionType.User,
          label: "John Doe",
          href: "https://example.com",
        })
      ).toBe(`@[John Doe](mention://${id}/user/${modelId})`);
    });
  });

  describe("document and collection mentions", () => {
    it("serializes a document mention as an internal link", () => {
      expect(
        serializeMention(
          { type: MentionType.Document, label: "Onboarding" },
          { commonMark: true }
        )
      ).toBe(`[Onboarding](/doc/${modelId})`);
    });

    it("serializes a collection mention as an internal link", () => {
      expect(
        serializeMention(
          { type: MentionType.Collection, label: "Engineering" },
          { commonMark: true }
        )
      ).toBe(`[Engineering](/collection/${modelId})`);
    });
  });

  describe("unfurled data", () => {
    const unfurl = {
      type: "issue",
      title: "Secret issue title",
      url: "https://gitlab.example.com/secret/p/-/issues/1",
    };

    it("does not write unfurled data or the title to the DOM", () => {
      const node = schema.nodeFromJSON({
        type: "mention",
        attrs: {
          id,
          modelId,
          type: MentionType.Issue,
          label: "Secret issue title",
          href: unfurl.url,
          unfurl,
        },
      });
      const spec = node.type.spec.toDOM?.(node) as unknown as [
        string,
        Record<string, unknown>,
        string,
      ];

      expect(spec[1]).not.toHaveProperty("data-unfurl");
      expect(spec[2]).toBe(unfurl.url);
      expect(node.textContent).toBe(unfurl.url);
    });

    it("keeps the label of internal mentions", () => {
      const node = schema.nodeFromJSON({
        type: "mention",
        attrs: { id, modelId, type: MentionType.User, label: "Jane" },
      });
      expect(node.textContent).toBe("@Jane");
    });
  });
});
