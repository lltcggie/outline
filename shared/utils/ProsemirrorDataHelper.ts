import type { ProsemirrorData } from "../types";
import { MentionType } from "../types";

/**
 * The label of an external mention whose URL is unknown. It replaces a label
 * that may be the title of the resource, and is never displayed as such.
 */
export const UnavailableMentionLabel = "Unavailable link";

/**
 * Mention types that point at a resource outside of Outline and are displayed
 * by unfurling their URL with the credentials of the viewer.
 */
const UnfurledMentionTypes: ReadonlySet<string> = new Set([
  MentionType.Issue,
  MentionType.PullRequest,
  MentionType.Project,
  MentionType.URL,
]);

/**
 * Helpers that operate on plain `ProsemirrorData` JSON.
 */
export class ProsemirrorDataHelper {
  /**
   * Get a new empty document.
   *
   * @returns a new empty document as JSON.
   */
  static getEmpty(): ProsemirrorData {
    return {
      type: "doc",
      content: [
        {
          content: [],
          type: "paragraph",
        },
      ],
    };
  }

  /**
   * Returns true if the data looks like an empty document.
   *
   * @param data The ProsemirrorData to check.
   * @returns True if the document is empty.
   */
  static isEmpty(data: ProsemirrorData): boolean {
    if (data.type !== "doc") {
      return false;
    }

    if (data.content?.length === 1) {
      const node = data.content[0];
      return (
        node.type === "paragraph" &&
        (node.content === null ||
          node.content === undefined ||
          node.content.length === 0)
      );
    }

    return !data.content || data.content.length === 0;
  }

  /**
   * Whether a mention of the given type is displayed by unfurling an external
   * URL. The unfurled data depends on the permissions of whoever fetched it, so
   * it must never be stored with the mention.
   *
   * @param type the mention type.
   * @returns true if the mention is unfurled from an external URL.
   */
  static isUnfurledMention(type: unknown): boolean {
    return typeof type === "string" && UnfurledMentionTypes.has(type);
  }

  /**
   * Returns the given value if it is the URL of an external resource that a
   * mention can point at.
   *
   * @param value the value to check.
   * @returns the http or https URL, or undefined.
   */
  static getExternalHref(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Computes the attributes of a mention without data unfurled from an
   * external service. The `unfurl` attribute is dropped and the `label` is
   * reset to the URL. A mention whose URL was lost, for example in markdown
   * written by an earlier version, gets it back from a label that is a URL,
   * otherwise the label, which may be the title of the resource, is replaced.
   *
   * @param attrs the attributes of the mention.
   * @returns the cleaned attributes, or undefined when nothing changes.
   */
  static getCleanedMentionAttrs(
    attrs: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!this.isUnfurledMention(attrs.type)) {
      return undefined;
    }

    const href =
      this.getExternalHref(attrs.href) ?? this.getExternalHref(attrs.label);
    const label = href ?? UnavailableMentionLabel;
    // Nodes serialized by Prosemirror carry the attribute without a value, as
    // it defaults to undefined.
    const hasUnfurl = attrs.unfurl !== undefined && attrs.unfurl !== null;

    if (
      !hasUnfurl &&
      label === attrs.label &&
      (href === undefined || href === attrs.href)
    ) {
      return undefined;
    }

    const cleaned: Record<string, unknown> = { ...attrs, label };
    delete cleaned.unfurl;
    if (href !== undefined) {
      cleaned.href = href;
    }
    return cleaned;
  }

  /**
   * Removes data that was unfurled from an external service from all mentions
   * in the given value, see `getCleanedMentionAttrs`. Any JSON value is
   * accepted so that copies of content embedded in other records, such as
   * event changes, can be cleaned as well.
   *
   * @param data the value to clean.
   * @returns the cleaned value, or the same reference when nothing changed.
   */
  static removeUnfurledMentionData<T>(data: T): T {
    // The walk preserves the shape of the input, only mention attrs change.
    return removeUnfurledMentionDataFromValue(data) as T;
  }
}

/**
 * Recursively removes unfurled data from mention nodes found in a JSON value.
 * Values are only copied along the path to a changed mention, so that the
 * common case of content without unfurled data allocates nothing.
 *
 * @param value the value to walk.
 * @returns the cleaned value, or the same reference when nothing changed.
 */
function removeUnfurledMentionDataFromValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    let result: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const item: unknown = value[index];
      const cleaned = removeUnfurledMentionDataFromValue(item);
      if (cleaned !== item) {
        result ??= value.slice();
        result[index] = cleaned;
      }
    }
    return result ?? value;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  // Text nodes, the most numerous, only carry marks that never hold a mention.
  if (record.type === "text") {
    return record;
  }

  let result: Record<string, unknown> | undefined;

  for (const key of Object.keys(record)) {
    const item = record[key];
    const cleaned = removeUnfurledMentionDataFromValue(item);
    if (cleaned !== item) {
      result ??= { ...record };
      result[key] = cleaned;
    }
  }

  const current = result ?? record;
  const attrs = current.attrs;
  if (
    current.type !== "mention" ||
    !attrs ||
    typeof attrs !== "object" ||
    Array.isArray(attrs)
  ) {
    return current;
  }

  const cleanedAttrs = ProsemirrorDataHelper.getCleanedMentionAttrs(
    attrs as Record<string, unknown>
  );
  return cleanedAttrs ? { ...current, attrs: cleanedAttrs } : current;
}
