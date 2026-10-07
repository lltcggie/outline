import env from "@shared/env";
import { MentionType } from "@shared/types";
import { integrationSettingsPath } from "@shared/utils/routeHelpers";

export const AsanaOAuthNonceCookie = "asanaOAuthNonce";

/** The state carried through the OAuth flow, see authUrl and parseState. */
export interface OAuthState {
  /** The team the user linking the account belongs to, for routing. */
  teamId: string;
  /** The nonce that ties the callback to the session that started it. */
  nonce: string;
}

/** A task or project an Asana URL points at. */
export type AsanaResource =
  | {
      type: "task";
      /** The task gid. */
      gid: string;
      /** The project the URL opened the task in, if any. */
      projectGid?: string;
    }
  | {
      type: "project";
      /** The project gid. */
      gid: string;
    };

/**
 * Helpers shared by the client and the server of the Asana plugin: the URLs
 * of Asana, the OAuth URLs and state, and the recognition of the task or
 * project an app.asana.com link points at.
 */
export class AsanaUtils {
  /** The host of the Asana web application. */
  public static hostname = "app.asana.com";

  public static apiUrl = "https://app.asana.com/api/1.0";
  public static authorizeUrl = "https://app.asana.com/-/oauth_authorize";
  public static tokenUrl = "https://app.asana.com/-/oauth_token";

  /** The color of completed tasks and active projects. */
  public static completedColor = "#58a182";

  /** The color of incomplete tasks and archived projects. */
  public static incompleteColor = "#6d6e6f";

  /** The color of projects without a color of their own. */
  public static defaultProjectColor = "#8da3a6";

  private static gidPattern = /^\d+$/;

  /** The colors a project can be given in Asana. */
  private static projectColors: Record<string, string> = {
    "dark-pink": "#e362e3",
    "dark-green": "#62d26f",
    "dark-blue": "#4186e0",
    "dark-red": "#e8384f",
    "dark-teal": "#20aaea",
    "dark-brown": "#eec300",
    "dark-orange": "#fd612c",
    "dark-purple": "#7a6ff0",
    "dark-warm-gray": "#8da3a6",
    "light-pink": "#fc91ad",
    "light-green": "#a4cf30",
    "light-blue": "#4573d2",
    "light-red": "#fb5779",
    "light-teal": "#37c5ab",
    "light-brown": "#f8df72",
    "light-orange": "#fd9a00",
    "light-purple": "#aa62e3",
    "light-warm-gray": "#a6a6a6",
  };

  /**
   * Returns the color a project is shown with.
   *
   * @param color the color name of the project in Asana, if any.
   * @returns a hex color string.
   */
  public static getColorForProject(color?: string | null): string {
    return (color && this.projectColors[color]) || this.defaultProjectColor;
  }

  /**
   * Determines the type of mention an Asana URL represents.
   *
   * @param url the URL to evaluate.
   * @returns the mention type, or undefined if this is not an Asana URL for a
   * task or project.
   */
  public static mentionType(url: URL): MentionType | undefined {
    const resource = this.parseUrl(url);

    switch (resource?.type) {
      case "task":
        return MentionType.Issue;
      case "project":
        return MentionType.Project;
      default:
        return undefined;
    }
  }

  /** The path of the Asana settings page, where OAuth redirects back to. */
  public static get url() {
    return integrationSettingsPath("asana");
  }

  /**
   * Generates the settings URL to redirect to after an authorization error.
   *
   * @param error the error to include in the URL.
   * @returns the URL to redirect to.
   */
  public static errorUrl(error: string): string {
    return `${this.url}?error=${encodeURIComponent(error)}`;
  }

  /**
   * Generates the callback URL for Asana OAuth.
   *
   * @param baseUrl the base URL of the application.
   * @param params optional query parameters to include in the callback URL.
   * @returns the full callback URL.
   */
  public static callbackUrl(
    { baseUrl, params }: { baseUrl: string; params?: string } = {
      baseUrl: env.URL,
      params: undefined,
    }
  ): string {
    const callbackPath = "/api/asana.callback";
    return params
      ? `${baseUrl}${callbackPath}?${params}`
      : `${baseUrl}${callbackPath}`;
  }

  /**
   * Generates the authorization URL for Asana OAuth.
   *
   * @param state the OAuth state with teamId for routing and nonce for CSRF.
   * @param clientId the client id of the OAuth application.
   * @param scopes the scopes to request, space separated.
   * @returns the URL to redirect the user to Asana's authorization page.
   */
  public static authUrl(
    state: OAuthState,
    clientId: string,
    scopes: string
  ): string {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.callbackUrl(),
      response_type: "code",
      state: JSON.stringify(state),
      scope: scopes,
    });

    return `${this.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Parses an OAuth state string from an Asana callback.
   *
   * @param state the state string carried in the callback query.
   * @returns the parsed OAuth state, or undefined if it cannot be parsed.
   */
  public static parseState(state: string): OAuthState | undefined {
    try {
      return JSON.parse(state);
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a URL is on the Asana web application. The scheme is not checked,
   * Asana redirects http to https so an http link points at the same resource
   * and must not be passed on to other unfurl providers either.
   *
   * @param input the URL to check.
   * @returns true if the URL is hosted on app.asana.com.
   */
  public static isAsanaUrl(input: string | URL): boolean {
    const url = this.toUrl(input);
    return !!url && url.hostname === this.hostname;
  }

  /**
   * Recognizes the Asana task or project an app.asana.com URL points at.
   *
   * Supported forms:
   *   https://app.asana.com/1/{workspace}/project/{project}/task/{task}
   *   https://app.asana.com/1/{workspace}/task/{task}
   *   https://app.asana.com/1/{workspace}/project/{project}/list/{view}  (and board, overview, …)
   *   https://app.asana.com/0/{project}/{task}[/f]
   *   https://app.asana.com/0/0/{task}
   *   https://app.asana.com/0/{project}[/list|/board|…]
   *
   * @param input the URL to parse.
   * @returns the resource, or undefined for any other URL (inbox, search, home, …).
   */
  public static parseUrl(input: string | URL): AsanaResource | undefined {
    const url = this.toUrl(input);
    if (!url || !this.isAsanaUrl(url)) {
      return undefined;
    }

    const parts = url.pathname.split("/").filter(Boolean);

    // Current URL format: /1/{workspace}/...
    if (parts[0] === "1") {
      const rest = parts.slice(2);

      const projectIndex = rest.indexOf("project");
      const projectGid =
        projectIndex !== -1 && this.isGid(rest[projectIndex + 1])
          ? rest[projectIndex + 1]
          : undefined;

      const taskIndex = rest.lastIndexOf("task");
      if (taskIndex !== -1 && this.isGid(rest[taskIndex + 1])) {
        return { type: "task", gid: rest[taskIndex + 1], projectGid };
      }

      return projectGid ? { type: "project", gid: projectGid } : undefined;
    }

    // Legacy URL format: /0/{project or 0}/{task}
    if (parts[0] === "0") {
      const [, container, item] = parts;

      if (!container || !this.gidPattern.test(container)) {
        return undefined; // /0/search, /0/inbox, /0/home, …
      }

      if (this.isGid(item)) {
        return {
          type: "task",
          gid: item,
          projectGid: this.isGid(container) ? container : undefined,
        };
      }

      return this.isGid(container)
        ? { type: "project", gid: container }
        : undefined;
    }

    return undefined;
  }

  /**
   * Whether a path segment is a gid. Asana uses "0" for "no project" in
   * legacy URLs, which is not a gid of its own.
   *
   * @param value the path segment.
   * @returns true if the segment is a gid.
   */
  private static isGid(value: string | undefined): value is string {
    return !!value && this.gidPattern.test(value) && value !== "0";
  }

  /**
   * Parses a URL unless it is already parsed.
   *
   * @param input the URL string or object.
   * @returns the parsed URL, or undefined if the string is not a valid URL.
   */
  private static toUrl(input: string | URL): URL | undefined {
    if (input instanceof URL) {
      return input;
    }

    try {
      return new URL(input);
    } catch {
      return undefined;
    }
  }
}
