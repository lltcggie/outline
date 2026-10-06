import { sanitizeUrl } from "../../utils/urls";
import type Token from "markdown-it/lib/token.mjs";
import type {
  NodeSpec,
  Node as ProsemirrorNode,
  NodeType,
  Schema,
} from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { NodeSelection, TextSelection } from "prosemirror-state";
import type { Primitive } from "utility-types";
import { v4 as uuidv4 } from "uuid";
import env from "../../env";
import { t } from "i18next";
import { AlignImageRightIcon, EmailIcon } from "outline-icons";
import { MentionDisplay, MentionType } from "../../types";
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
import { selectBlockLikeVertically } from "../commands/selectBlockLikeVertically";
import type { MarkdownSerializerState } from "../lib/markdown/serializer";
import { canDisplayAsCard, transformListToMentions } from "../lib/mention";
import { findParentNodeClosestToPos } from "../queries/findParentNode";
import { isInList } from "../queries/isInList";
import { isList } from "../queries/isList";
import { RepairPlugin } from "../plugins/RepairPlugin";
import mentionRule from "../rules/mention";
import { isNodeActive } from "../queries/isNodeActive";
import type {
  ComponentProps,
  NodeWithPos,
  SelectionToolbarMenuDescriptor,
} from "../types";
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
        display: {
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
              display:
                dom.dataset.display === MentionDisplay.Card
                  ? MentionDisplay.Card
                  : undefined,
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
          // Dates have nothing to unfurl and cards already show the preview,
          // so both opt out of the hover preview behaviour.
          class:
            node.attrs.type === MentionType.Date ||
            node.attrs.display === MentionDisplay.Card
              ? node.type.name
              : `${node.type.name} use-hover-preview`,
          id: node.attrs.id,
          href: sanitizeUrl(
            node.attrs.type === MentionType.User ||
              node.attrs.type === MentionType.Date
              ? undefined
              : node.attrs.type === MentionType.Document
                ? `${env.URL}/doc/${node.attrs.modelId}${
                    node.attrs.anchorId ? `#${node.attrs.anchorId}` : ""
                  }`
                : node.attrs.type === MentionType.Collection
                  ? `${env.URL}/collection/${node.attrs.modelId}`
                  : node.attrs.href
          ),
          "data-type": node.attrs.type,
          "data-id": node.attrs.modelId,
          "data-actorid": node.attrs.actorId,
          "data-anchor-id": node.attrs.anchorId,
          "data-url": isExternalMention(node.attrs.type)
            ? sanitizeUrl(node.attrs.href)
            : `mention://${node.attrs.id}/${node.attrs.type}/${node.attrs.modelId}`,
          "data-display":
            node.attrs.display === MentionDisplay.Card
              ? MentionDisplay.Card
              : undefined,
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

  selectionToolbarMenus(): SelectionToolbarMenuDescriptor[] {
    return [
      {
        priority: 50,
        matches: (ctx) =>
          !ctx.readOnly &&
          ctx.selection instanceof NodeSelection &&
          canDisplayAsCard(ctx.selection.node),
        getItems: (ctx) => {
          const { schema } = ctx;
          return [
            {
              name: "mentionDisplay",
              tooltip: t("Display as mention"),
              attrs: { display: MentionDisplay.Inline },
              active: (state) =>
                state.selection instanceof NodeSelection &&
                state.selection.node.attrs.display !== MentionDisplay.Card,
              icon: <EmailIcon />,
            },
            {
              name: "mentionDisplay",
              tooltip: t("Display as card"),
              attrs: { display: MentionDisplay.Card },
              active: isNodeActive(schema.nodes.mention, {
                display: MentionDisplay.Card,
              }),
              icon: <AlignImageRightIcon />,
            },
          ];
        },
      },
    ];
  }

  get plugins() {
    return [
      // Ensure mentions have unique IDs. Unchanged mentions keep their id, so
      // a pasted copy is given a new id rather than the original.
      new RepairPlugin({
        needsRepair: (node) => node.type.name === this.name,
        repair: (state, mentions) => {
          const changed = mentions.filter((mention) => mention.changed);
          const changedPositions = new Set(changed.map(({ pos }) => pos));
          const ordered: NodeWithPos[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name === this.name && !changedPositions.has(pos)) {
              ordered.push({ node, pos });
            }
          });
          ordered.push(...changed);

          const seen = new Set<string>();
          const tr = state.tr;
          ordered.forEach(({ node, pos }) => {
            const { id } = node.attrs;
            if (id && !seen.has(id)) {
              seen.add(id);
              return;
            }
            tr.setNodeAttribute(pos, "id", uuidv4());
          });
          return tr.docChanged ? tr : null;
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
    const isCard = (node: ProsemirrorNode) =>
      node.type.name === this.name &&
      node.attrs.display === MentionDisplay.Card;

    return {
      ArrowUp: selectBlockLikeVertically(-1, isCard),
      ArrowDown: selectBlockLikeVertically(1, isCard),
      Enter: (state, dispatch) => {
        const { selection } = state;
        if (selection instanceof NodeSelection && isCard(selection.node)) {
          const tr = state.tr.split(selection.to, 1, [
            { type: state.schema.nodes.paragraph },
          ]);
          dispatch?.(
            tr
              .setSelection(TextSelection.create(tr.doc, selection.to + 2))
              .scrollIntoView()
          );
          return true;
        }

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
      mentionDisplay:
        (attrs: { display: MentionDisplay }): Command =>
        (state, dispatch) => {
          const { selection } = state;
          if (
            !(selection instanceof NodeSelection) ||
            !canDisplayAsCard(selection.node)
          ) {
            return false;
          }

          const tr = state.tr.setNodeAttribute(
            selection.from,
            "display",
            attrs.display === MentionDisplay.Card
              ? MentionDisplay.Card
              : undefined
          );
          dispatch?.(
            tr.setSelection(NodeSelection.create(tr.doc, selection.from))
          );
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
    const isCard = node.attrs.display === MentionDisplay.Card;

    // The link title stores the card display, so the URL is not changed.
    const title = isCard ? ` "${MentionDisplay.Card}"` : "";

    // Use regular links for document and collection mentions. Cards add the
    // "@" prefix so they are parsed back into a mention.
    if (mType === MentionType.Document || mType === MentionType.Collection) {
      const href =
        mType === MentionType.Document
          ? `/doc/${mId}${node.attrs.anchorId ? `#${node.attrs.anchorId}` : ""}`
          : `/collection/${mId}`;
      state.write(`${isCard ? "@" : ""}[${label}](${href}${title})`);
    } else if (
      (state.options.commonMark || isCard) &&
      ProsemirrorDataHelper.isUnfurledMention(mType) &&
      node.attrs.href
    ) {
      // Markdown that leaves Outline cannot resolve a mention:// reference, so
      // external mentions fall back to the URL they already carry. Cards need
      // the URL to render, so they always use it. The "@" prefix allows them to
      // be parsed back into a mention on the way in.
      state.write(`@[${label}](${sanitizeUrl(node.attrs.href)}${title})`);
    } else {
      // Keep the mention:// format for everything else, it round-trips back
      // into a live mention through Outline's own parser. The URL of an
      // external mention is carried along so that it is not lost.
      state.write(
        `@[${label}](mention://${id}/${mType}/${mId}${mentionHrefQuery(node)}${title})`
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
        anchorId: tok.attrGet("anchorId") ?? undefined,
        label: tok.content,
        display:
          tok.attrGet("display") === MentionDisplay.Card
            ? MentionDisplay.Card
            : undefined,
      }),
    };
  }

  handleChangeDate =
    ({
      node,
      getPos,
    }: {
      node: ProsemirrorNode;
      getPos: () => number | undefined;
    }) =>
    (modelId: string) => {
      const { view } = this.editor;
      const { tr } = view.state;
      const pos = getPos();

      if (pos === undefined || node.attrs.modelId === modelId) {
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
