import { DOMParser, type Node as ProsemirrorNode } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import { NodeSelection } from "prosemirror-state";
import { MentionDisplay, MentionType } from "../../types";
import {
  createEditorState,
  parser,
  schema,
  serializer,
} from "../../test/editor";
import { UnavailableMentionLabel } from "../../utils/ProsemirrorDataHelper";
import Mention from "./Mention";

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

describe("Mention ids", () => {
  const mention = (mentionId: string | null) =>
    schema.nodes.mention.create({
      id: mentionId,
      modelId,
      type: MentionType.User,
      label: "Name",
    });

  const ids = (state: EditorState) => {
    const result: string[] = [];
    state.doc.descendants((node) => {
      if (node.type.name === "mention") {
        result.push(node.attrs.id);
      }
    });
    return result;
  };

  it("gives a pasted duplicate a new id and keeps the original", () => {
    const state = createEditorState(
      schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(null, [mention(id)]),
        schema.nodes.paragraph.create(),
      ]),
      new Mention().plugins
    );

    const typed = state.apply(state.tr.insertText("x", 4));
    const pasted = typed.apply(typed.tr.insert(4, mention(id)));

    const [original, copy] = ids(pasted);
    expect(original).toBe(id);
    expect(copy).toEqual(expect.any(String));
    expect(copy).not.toBe(id);
  });

  it("keeps the original id when a duplicate is pasted as the first change", () => {
    const state = createEditorState(
      schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(null, [mention(id)]),
        schema.nodes.paragraph.create(),
      ]),
      new Mention().plugins
    );

    const pasted = state.apply(state.tr.insert(4, mention(id)));

    const [original, copy] = ids(pasted);
    expect(original).toBe(id);
    expect(copy).toEqual(expect.any(String));
    expect(copy).not.toBe(id);
  });

  it("gives the later of two loaded duplicates a new id", () => {
    const state = createEditorState(
      schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(null, [mention(id)]),
        schema.nodes.paragraph.create(null, [mention(id)]),
        schema.nodes.paragraph.create(),
      ]),
      new Mention().plugins
    );

    const newState = state.apply(state.tr.insertText("x", 7));

    const [first, second] = ids(newState);
    expect(first).toBe(id);
    expect(second).not.toBe(id);
  });

  it("assigns an id to a mention without one", () => {
    const state = createEditorState(
      schema.nodes.doc.create(null, [schema.nodes.paragraph.create()]),
      new Mention().plugins
    );

    const newState = state.apply(state.tr.insert(1, mention(null)));

    expect(ids(newState)[0]).toEqual(expect.any(String));
  });
});

describe("Mention display", () => {
  const href = "https://example.com/article";

  const urlMention = (attrs: Record<string, unknown> = {}) =>
    schema.nodes.mention.create({
      id,
      modelId,
      type: MentionType.URL,
      label: "Article",
      href,
      ...attrs,
    });

  const selectMention = (node: ReturnType<typeof urlMention>) => {
    const state = createEditorState(
      schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(null, [node]),
      ])
    );
    return state.apply(
      state.tr.setSelection(NodeSelection.create(state.doc, 1))
    );
  };

  const setDisplay = (state: EditorState, display: MentionDisplay) => {
    const commands = new Mention().commands({
      type: schema.nodes.mention,
      schema,
    });
    let next = state;
    const handled = commands.mentionDisplay({ display })(state, (tr) => {
      next = state.apply(tr);
    });
    return { handled, next };
  };

  it("keeps the JSON of an existing inline mention unchanged", () => {
    const json = {
      type: "mention",
      attrs: { type: MentionType.URL, label: "Article", modelId, id, href },
    };
    const node = schema.nodeFromJSON(json);

    expect(node.attrs.display).toBeUndefined();
    expect(JSON.stringify(node.toJSON())).toBe(JSON.stringify(json));
  });

  it.each([undefined, MentionDisplay.Card])(
    "writes display %s to the DOM and reads it back",
    (display) => {
      const spec = schema.nodes.mention.spec;
      const node = urlMention({ display });
      const [, domAttrs] = spec.toDOM!(node) as [
        string,
        Record<string, string>,
      ];
      expect(domAttrs["data-display"]).toBe(display);

      const rule = spec.parseDOM?.[0] as {
        getAttrs: (dom: unknown) => Record<string, unknown>;
      };
      const attrs = rule.getAttrs({
        dataset: { type: MentionType.URL, id: modelId, display },
        innerText: "Article",
        id,
        getAttribute: () => href,
      });
      expect(attrs.display).toBe(display);
    }
  );

  it("switches a selected link mention between inline and card", () => {
    const state = selectMention(urlMention());

    const toCard = setDisplay(state, MentionDisplay.Card);
    expect(toCard.handled).toBe(true);
    expect(toCard.next.doc.nodeAt(1)?.attrs.display).toBe(MentionDisplay.Card);
    expect(toCard.next.selection).toBeInstanceOf(NodeSelection);

    const toInline = setDisplay(toCard.next, MentionDisplay.Inline);
    expect(toInline.next.doc.nodeAt(1)?.attrs.display).toBeUndefined();
    expect(JSON.stringify(toInline.next.doc.toJSON())).toBe(
      JSON.stringify(state.doc.toJSON())
    );
  });

  it.each([MentionType.Document, MentionType.Collection])(
    "switches a selected %s mention to a card",
    (type) => {
      const state = selectMention(urlMention({ type, href: undefined }));
      const toCard = setDisplay(state, MentionDisplay.Card);
      expect(toCard.handled).toBe(true);
      expect(toCard.next.doc.nodeAt(1)?.attrs.display).toBe(
        MentionDisplay.Card
      );
    }
  );

  it("does not change the display of other mention types", () => {
    const state = selectMention(urlMention({ type: MentionType.User }));
    expect(setDisplay(state, MentionDisplay.Card).handled).toBe(false);
  });

  it("creates a paragraph below a selected card on Enter", () => {
    const state = selectMention(urlMention({ display: MentionDisplay.Card }));
    let next = state;
    const handled = new Mention().keys().Enter(state, (tr) => {
      next = state.apply(tr);
    });

    expect(handled).toBe(true);
    expect(next.doc.childCount).toBe(2);
    expect(next.doc.child(0).firstChild?.attrs.display).toBe(
      MentionDisplay.Card
    );
    expect(next.doc.child(1).content.size).toBe(0);
    expect(next.selection.$head.parent).toBe(next.doc.child(1));
  });

  it("creates a paragraph below a selected card in a heading", () => {
    const state = createEditorState(
      schema.nodes.doc.create(null, [
        schema.nodes.heading.create({ level: 2 }, [
          urlMention({ display: MentionDisplay.Card }),
        ]),
      ])
    );
    const selected = state.apply(
      state.tr.setSelection(NodeSelection.create(state.doc, 1))
    );
    let next = selected;
    new Mention().keys().Enter(selected, (tr) => {
      next = selected.apply(tr);
    });

    expect(next.doc.child(0).type.name).toBe("heading");
    expect(next.doc.child(1).type.name).toBe("paragraph");
    expect(next.selection.$head.parent).toBe(next.doc.child(1));
  });
});

describe("Mention markdown round trip", () => {
  const roundTrip = (
    attrs: Record<string, unknown>,
    options?: { commonMark?: boolean }
  ) => {
    const markdown = serializeMention(attrs, options);
    let mention: ReturnType<typeof schema.nodes.mention.create> | undefined;
    parser.parse(markdown)?.descendants((node) => {
      if (node.type.name === "mention") {
        mention = node;
      }
    });
    return { markdown, mention };
  };

  const cases: Record<string, Record<string, unknown>> = {
    url: {
      type: MentionType.URL,
      label: "Example",
      href: "https://example.com/a?b=c",
    },
    document: { type: MentionType.Document, label: "Roadmap" },
    collection: { type: MentionType.Collection, label: "Product" },
  };

  describe.each([false, true])("with commonMark %s", (commonMark) => {
    it.each(Object.keys(cases))("keeps a %s card", (key) => {
      const { markdown, mention } = roundTrip(
        { ...cases[key], display: MentionDisplay.Card },
        { commonMark }
      );
      expect(markdown).toContain('"card")');
      expect(mention?.attrs.type).toBe(cases[key].type);
      expect(mention?.attrs.display).toBe(MentionDisplay.Card);
    });

    it.each(Object.keys(cases))(
      "does not add a title to an inline %s",
      (key) => {
        const { markdown } = roundTrip(cases[key], { commonMark });
        expect(markdown).not.toContain('"card"');
      }
    );
  });

  it.each([false, true])(
    "keeps the url of a link card with commonMark %s",
    (commonMark) => {
      const { markdown, mention } = roundTrip(
        { ...cases.url, display: MentionDisplay.Card },
        { commonMark }
      );
      // The label of an external mention is never its unfurled title.
      expect(markdown).toBe(
        '@[https://example.com/a?b=c](https://example.com/a?b=c "card")'
      );
      expect(mention?.attrs.href).toBe("https://example.com/a?b=c");
    }
  );

  it("keeps the model id of a document card", () => {
    const { mention } = roundTrip({
      ...cases.document,
      display: MentionDisplay.Card,
    });
    expect(mention?.attrs.modelId).toBe(modelId);
  });

  it("keeps the anchor of a document card", () => {
    const { markdown, mention } = roundTrip({
      ...cases.document,
      anchorId: "h-goals",
      display: MentionDisplay.Card,
    });
    expect(markdown).toBe(`@[Roadmap](/doc/${modelId}#h-goals "card")`);
    expect(mention?.attrs.anchorId).toBe("h-goals");
  });

  it("keeps inline document mentions as plain links", () => {
    expect(serializeMention(cases.document)).toBe(`[Roadmap](/doc/${modelId})`);
  });

  it("omits the display from an inline mention parsed from Markdown", () => {
    const { mention } = roundTrip(cases.url, { commonMark: true });

    expect(mention).toBeDefined();
    expect(JSON.stringify(mention?.toJSON())).not.toContain('"display"');
  });
});
