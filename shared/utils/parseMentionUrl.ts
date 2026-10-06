/**
 * Parse a mention:// URL into its components.
 *
 * Supports both the 3-segment format (mention://id/type/modelId) and the
 * 2-segment format (mention://type/modelId). Mentions of external resources
 * may carry the URL of the resource in an `href` query parameter.
 *
 * @param url the mention URL to parse.
 * @returns the parsed components, or an empty object if the URL is invalid.
 */
const parseMentionUrl = (
  url: string
): { id?: string; mentionType?: string; modelId?: string; href?: string } => {
  // The modelId is a UUID, a date (2024-02-03) or a datetime (2024-02-03T13:00).
  const match3 = url.match(
    /^mention:\/\/([a-z0-9-]+)\/([a-z_]+)\/([a-z0-9-]+(?:T\d{2}:\d{2})?)(?:\?href=([^\s&#]+))?$/
  );
  if (match3) {
    const [id, mentionType, modelId, href] = match3.slice(1);
    return { id, mentionType, modelId, ...decodeHref(href) };
  }

  const match2 = url.match(
    /^mention:\/\/([a-z_]+)\/([a-z0-9-]+(?:T\d{2}:\d{2})?)(?:\?href=([^\s&#]+))?$/
  );
  if (match2) {
    const [mentionType, modelId, href] = match2.slice(1);
    return { mentionType, modelId, ...decodeHref(href) };
  }

  return {};
};

/**
 * Decodes the `href` query parameter of a mention URL.
 *
 * @param href the encoded parameter, if present.
 * @returns an object with the decoded href, or an empty object when it is
 * missing or malformed.
 */
function decodeHref(href: string | undefined): { href?: string } {
  if (!href) {
    return {};
  }
  try {
    return { href: decodeURIComponent(href) };
  } catch {
    return {};
  }
}

export default parseMentionUrl;
