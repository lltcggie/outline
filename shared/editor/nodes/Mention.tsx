import { sanitizeUrl } from "../../utils/urls";
import type Token from "markdown-it/lib/token.mjs";
import type {
  NodeSpec,
  Node as ProsemirrorNode,
  NodeType,
  Schema,
} from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { NodeSelection, Plugin, TextSelection } from "prosemirror-state";
import type { Primitive } from "utility-types";
import { v4 as uuidv4 } from "uuid";
import env from "../../env";
import { MentionType } from "../../types";
import { dateToReadable } from "../../utils/date";
import { ProsemirrorDataHelper } from "../../utils/ProsemirrorDataHelper";
import {
  MentionCollection,
  MentionDocument,
  MentionGroup,
  MentionIssue,
  MentionProject,
  MentionPullRequest,
  MentionDate,
  MentionURL,
  MentionUser,
} from "../components/Mentions";
import type { MarkdownSerializerState } from "../lib/markdown/serializer";
import { transformListToMentions } from "../lib/mention";
import { findParentNodeClosestToPos } from "../queries/findParentNode";
import { isInList } from "../queries/isInList";
import { isList } from "../queries/isList";
import mentionRule from "../rules/mention";
import type { ComponentProps } from "../types";
import Node from "./Node";

/**
 * Formats a date mention's stored value (a date-only or time-specific ISO
 * string) into a human-readable label for display and serialization.
 *
 * @param node the date mention node.
 * @returns the readable label, e.g. "February 3rd at 1:00 PM".
 */
function dateMentionLabel(node: ProsemirrorNode): string {
  const modelId = node.attrs.modelId;
  return typeof modelId === "string"
    ? dateToReadable(modelId)
    : node.attrs.label;
}

/**
 * Whether a mention points at a resource outside of Outline, in which case the
 * real URL is stored in `attrs.href` rather than addressed with a `mention://`
 * reference.
 *
 * @param type the mention type.
 * @returns true if the mention links to an external URL.
 */
function isExternalMention(type: MentionType): boolean {
  return (
    ProsemirrorDataHelper.isUnfurledMention(type) && type !== MentionType.URL
  );
}

/**
 * The text to display for a mention outside of the editor. Mentions of
 * external resources only ever show their URL, the title of the resource
 * depends on the permissions of whoever unfurled it and must not be persisted.
 *
 * @param node the mention node.
 * @returns the text that represents the mention.
 */
function mentionLabel(node: ProsemirrorNode): string {
  if (node.attrs.type === MentionType.Date) {
    return dateMentionLabel(node);
  }
  const cleaned = ProsemirrorDataHelper.getCleanedMentionAttrs(node.attrs);
  return cleaned ? String(cleaned.label) : node.attrs.label;
}

/**
 * Encodes the URL of an external mention as the `href` query parameter of a
 * mention:// reference, so that it is kept in markdown staying within Outline
 * together with the type and ids of the mention.
 *
 * @param node the mention node.
 * @returns the query string, or an empty string when there is no URL.
 */
function mentionHrefQuery(node: ProsemirrorNode): string {
  if (!ProsemirrorDataHelper.isUnfurledMention(node.attrs.type)) {
    return "";
  }
  const href = ProsemirrorDataHelper.getExternalHref(
    sanitizeUrl(node.attrs.href)
  );
  if (!href) {
    return "";
  }
  // Parentheses are not encoded by encodeURIComponent, but would end the link
  // destination in markdown.
  const encoded = encodeURIComponent(href).replace(
    /[()]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `?href=${encoded}`;
}

export default class Mention extends Node {
  get name() {
    return "mention";
  }

  /** The component requires stores and a router, neither of which exist outside the app. */
  get allowComponentInStaticHTML() {
    return false;
  }

  get schema(): NodeSpec {
    const toPlainText = (node: ProsemirrorNode) => {
      if (node.attrs.type === MentionType.User) {
        return `@${node.attrs.label}`;
      }
      return mentionLabel(node);
    };

    return {
      attrs: {
        type: {
          default: MentionType.User,
        },
        label: {},
        modelId: {},
        actorId: {
          default: undefined,
        },
        id: {
          default: undefined,
        },
        anchorId: {
          default: undefined,
        },
        href: {
          default: undefined,
        },
        unfurl: {
          default: undefined,
        },
      },
      inline: true,
      marks: "",
      group: "inline",
      atom: true,
      parseDOM: [
        {
          tag: `.${this.name}`,
          preserveWhitespace: "full",
          priority: 100,
          getAttrs: (dom: HTMLElement) => {
            const type = dom.dataset.type;
            const modelId = dom.dataset.id;
            if (!type || !modelId) {
              return false;
            }

            const href = dom.getAttribute("href");
            const attrs = {
              type,
              modelId,
              actorId: dom.dataset.actorid,
              label: dom.innerText,
              id: dom.id,
              anchorId: dom.dataset.anchorId ?? href?.split("#")[1],
              href,
            };

            // Unfurled data is never read from the DOM, pasted or imported HTML
            // may carry the title fetched with another user's access.
            return ProsemirrorDataHelper.getCleanedMentionAttrs(attrs) ?? attrs;
          },
        },
      ],
      toDOM: (node) => [
        node.attrs.type === MentionType.User ||
        node.attrs.type === MentionType.Date
          ? "span"
          : "a",
        {
          // Date mentions are self-contained and have nothing to unfurl, so
          // they opt out of the hover preview behaviour.
          class:
            node.attrs.type === MentionType.Date
              ? node.type.name
              : `${node.type.name} use-hover-preview`,
          id: node.attrs.id,
          href:
            node.attrs.type === MentionType.User ||
            node.attrs.type === MentionType.Date
              ? undefined
              : node.attrs.type === MentionType.Document
                ? `${env.URL}/doc/${node.attrs.modelId}${
                    node.attrs.anchorId ? `#${node.attrs.anchorId}` : ""
                  }`
                : node.attrs.type === MentionType.Collection
                  ? `${env.URL}/collection/${node.attrs.modelId}`
                  : sanitizeUrl(node.attrs.href),
          "data-type": node.attrs.type,
          "data-id": node.attrs.modelId,
          "data-actorid": node.attrs.actorId,
          "data-anchor-id": node.attrs.anchorId,
          "data-url": isExternalMention(node.attrs.type)
            ? sanitizeUrl(node.attrs.href)
            : `mention://${node.attrs.id}/${node.attrs.type}/${node.attrs.modelId}`,
        },
        toPlainText(node),
      ],
      leafText: toPlainText,
    };
  }

  component = (props: ComponentProps) => {
    switch (props.node.attrs.type) {
      case MentionType.User:
        return <MentionUser {...props} />;
      case MentionType.Group:
        return <MentionGroup {...props} />;
      case MentionType.Document:
        return <MentionDocument {...props} />;
      case MentionType.Collection:
        return <MentionCollection {...props} />;
      case MentionType.Issue:
        return <MentionIssue {...props} />;
      case MentionType.PullRequest:
        return <MentionPullRequest {...props} />;
      case MentionType.Project:
        return <MentionProject {...props} />;
      case MentionType.URL:
        return <MentionURL {...props} />;
      case MentionType.Date:
        return (
          <MentionDate {...props} onChangeDate={this.handleChangeDate(props)} />
        );
      default:
        return null;
    }
  };

  get rulePlugins() {
    return [mentionRule];
  }

  get plugins() {
    return [
      // Ensure mentions have unique IDs
      new Plugin({
        appendTransaction: (_transactions, _oldState, newState) => {
          const tr = newState.tr;
          const existingIds = new Set();
          let modified = false;

          tr.doc.descendants((node, pos) => {
            let nodeId = node.attrs.id;
            if (
              node.type.name === this.name &&
              (!nodeId || existingIds.has(nodeId))
            ) {
              nodeId = uuidv4();
              modified = true;
              tr.setNodeAttribute(pos, "id", nodeId);
            }
            existingIds.add(nodeId);
          });

          if (modified) {
            return tr;
          }

          return null;
        },
      }),
    ];
  }

  keys(): Record<string, Command> {
    const NavigableMention = [
      MentionType.Collection,
      MentionType.Document,
      MentionType.Issue,
      MentionType.PullRequest,
      MentionType.Project,
    ];

    return {
      Enter: (state) => {
        const { selection } = state;
        if (
          selection instanceof NodeSelection &&
          selection.node.type.name === this.name &&
          NavigableMention.includes(selection.node.attrs.type)
        ) {
          const mentionType = selection.node.attrs.type;

          let link: string | undefined;

          if (isExternalMention(mentionType)) {
            link = sanitizeUrl(selection.node.attrs.href);
          } else {
            const { modelId } = selection.node.attrs;

            const linkType =
              selection.node.attrs.type === MentionType.Document
                ? "doc"
                : "collection";

            link = `/${linkType}/${modelId}${
              selection.node.attrs.anchorId
                ? `#${selection.node.attrs.anchorId}`
                : ""
            }`;
          }

          if (link) {
            this.editor.props.onClickLink?.(link);
          }
          return true;
        }
        return false;
      },
    };
  }

  commands({ type }: { type: NodeType; schema: Schema }) {
    return {
      mention:
        (attrs: Record<string, Primitive>): Command =>
        (state, dispatch) => {
          const { selection } = state;
          const position =
            selection instanceof TextSelection
              ? selection.$cursor?.pos
              : selection.$to.pos;
          if (position === undefined) {
            return false;
          }

          const node = type.create(attrs);
          const transaction = state.tr.insert(position, node);
          dispatch?.(transaction);
          return true;
        },
      mention_list:
        (attrs: Record<string, Primitive>): Command =>
        (state, dispatch) => {
          const { selection } = state;
          const position =
            selection instanceof TextSelection
              ? selection.$cursor?.pos
              : selection.$to.pos;

          if (position === undefined || !isInList(state)) {
            return false;
          }

          const resolvedPos = state.tr.doc.resolve(position);
          const nodeWithPos = findParentNodeClosestToPos(resolvedPos, (node) =>
            isList(node, this.editor.schema)
          );

          if (!nodeWithPos) {
            return false;
          }

          const listNode = nodeWithPos.node,
            from = nodeWithPos.pos,
            to = from + listNode.nodeSize;

          const listNodeWithMentions = transformListToMentions(
            listNode,
            this.editor.schema,
            attrs
          );

          const tr = state.tr.deleteRange(from, to);
          dispatch?.(
            tr
              .setSelection(TextSelection.near(tr.doc.resolve(from)))
              .replaceSelectionWith(listNodeWithMentions)
          );

          return true;
        },
    };
  }

  toMarkdown(state: MarkdownSerializerState, node: ProsemirrorNode) {
    const mType = node.attrs.type;
    const mId = node.attrs.modelId;
    // Date mentions store a machine-readable value, so the label is derived to
    // keep the serialized output legible outside of the editor.
    const label = mentionLabel(node);
    const id = node.attrs.id;

    // Use regular links for document and collection mentions
    if (mType === MentionType.Document) {
      state.write(
        `[${label}](/doc/${mId}${
          node.attrs.anchorId ? `#${node.attrs.anchorId}` : ""
        })`
      );
    } else if (mType === MentionType.Collection) {
      state.write(`[${label}](/collection/${mId})`);
    } else if (
      state.options.commonMark &&
      ProsemirrorDataHelper.isUnfurledMention(mType) &&
      node.attrs.href
    ) {
      // Markdown that leaves Outline cannot resolve a mention:// reference, so
      // external mentions fall back to the URL they already carry. The "@"
      // prefix allows them to be parsed back into a mention on the way in.
      state.write(`@[${label}](${sanitizeUrl(node.attrs.href)})`);
    } else {
      // Keep the mention:// format for everything else, it round-trips back
      // into a live mention through Outline's own parser. The URL of an
      // external mention is carried along so that it is not lost.
      state.write(
        `@[${label}](mention://${id}/${mType}/${mId}${mentionHrefQuery(node)})`
      );
    }
  }

  parseMarkdown() {
    return {
      node: "mention",
      getAttrs: (tok: Token) => ({
        id: tok.attrGet("id"),
        type: tok.attrGet("type"),
        modelId: tok.attrGet("modelId"),
        href: tok.attrGet("href") ?? undefined,
        label: tok.content,
      }),
    };
  }

  handleChangeDate =
    ({ node, getPos }: { node: ProsemirrorNode; getPos: () => number }) =>
    (modelId: string) => {
      const { view } = this.editor;
      const { tr } = view.state;
      const pos = getPos();

      if (node.attrs.modelId === modelId) {
        return;
      }

      const transaction = tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        modelId,
        label: modelId,
      });
      view.dispatch(transaction);
    };
}
