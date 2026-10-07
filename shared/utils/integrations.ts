/**
 * Whether a URL points at Asana, whose tasks are displayed with a status icon
 * of their own.
 *
 * @param url the URL of the resource.
 * @returns true if the URL is on Asana.
 */
export function isAsanaUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).hostname === "app.asana.com";
  } catch {
    return false;
  }
}
