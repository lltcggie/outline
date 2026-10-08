import queryString from "query-string";
import env from "@shared/env";
import { MentionType } from "@shared/types";
import { integrationSettingsPath } from "@shared/utils/routeHelpers";

export const GitHubOAuthNonceCookie = "githubOAuthNonce";

export type OAuthState = {
  teamId: string;
  nonce: string;
};

export class GitHubUtils {
  public static clientId = env.GITHUB_CLIENT_ID;

  /** The host of GitHub, whose links the plugin recognizes. */
  public static hostname = "github.com";

  static get url() {
    return integrationSettingsPath("github");
  }

  /**
   * @param error
   * @returns URL to be redirected to upon authorization error from GitHub
   */
  public static errorUrl(error: string) {
    return `${this.url}?error=${encodeURIComponent(error)}`;
  }

  /**
   * @returns Callback URL configured for GitHub, to which users will be redirected upon authorization
   */
  public static callbackUrl(
    { baseUrl, params }: { baseUrl: string; params?: string } = {
      baseUrl: env.URL,
      params: undefined,
    }
  ) {
    return params
      ? `${baseUrl}/api/github.callback?${params}`
      : `${baseUrl}/api/github.callback`;
  }

  /**
   * Generates the URL that installs the GitHub app on an organization or
   * account, which an admin does for the workspace. GitHub redirects to the
   * callback with the installation and, as the app requests user
   * authorization during installation, a code for the admin's own account.
   *
   * @param state the OAuth state with teamId for routing and nonce for CSRF.
   * @returns the URL to redirect the admin to.
   */
  static authUrl(state: OAuthState): string {
    const baseUrl = `https://github.com/apps/${env.GITHUB_APP_NAME}/installations/new`;
    const params = {
      client_id: this.clientId,
      redirect_uri: this.callbackUrl(),
      state: JSON.stringify(state),
    };
    return `${baseUrl}?${queryString.stringify(params)}`;
  }

  /**
   * Generates the URL that authorizes the GitHub app for the user's own
   * account, which every member does to link their account. GitHub redirects
   * to the callback with a code only, the permissions are those of the app.
   *
   * @param state the OAuth state with teamId for routing and nonce for CSRF.
   * @returns the URL to redirect the user to.
   */
  static userAuthUrl(state: OAuthState): string {
    const params = {
      client_id: this.clientId,
      redirect_uri: this.callbackUrl(),
      state: JSON.stringify(state),
    };
    return `https://github.com/login/oauth/authorize?${queryString.stringify(params)}`;
  }

  static parseState(state: string): OAuthState | undefined {
    try {
      return JSON.parse(state);
    } catch {
      return undefined;
    }
  }

  static installRequestUrl(): string {
    return `${this.url}?install_request=true`;
  }

  /**
   * Whether a URL is on GitHub.
   *
   * @param url the URL to check.
   * @returns true if the URL is hosted on github.com.
   */
  public static isGitHubUrl(url: string | URL): boolean {
    try {
      return (
        (typeof url === "string" ? new URL(url) : url).hostname ===
        this.hostname
      );
    } catch {
      return false;
    }
  }

  /**
   * Determines the type of mention a GitHub URL represents.
   *
   * @param url the URL to evaluate.
   * @returns the mention type, or undefined if this is not a GitHub URL for a
   * resource that can be mentioned.
   */
  public static mentionType(url: URL): MentionType | undefined {
    if (!this.isGitHubUrl(url)) {
      return undefined;
    }

    const type = url.pathname.split("/")[3];

    return type === "pull"
      ? MentionType.PullRequest
      : type === "issues"
        ? MentionType.Issue
        : type === "projects"
          ? MentionType.Project
          : undefined;
  }

  public static getColorForStatus(status: string, isDraftPR: boolean = false) {
    switch (status) {
      case "open":
        return isDraftPR ? "#848d97" : "#238636";
      case "done":
        return "#a371f7";
      case "closed":
        return "#f85149";
      case "completed":
      case "merged":
        return "#8250df";
      case "canceled":
      default:
        return "#848d97";
    }
  }
}
