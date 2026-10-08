import * as React from "react";
import { useTranslation } from "react-i18next";
import Button, { type Props } from "~/components/Button";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import { generateOAuthStateNonce } from "~/utils/oauth";
import { redirectTo } from "~/utils/urls";
import {
  GitHubOAuthNonceCookie,
  GitHubUtils,
  type OAuthState,
} from "../../shared/GitHubUtils";

/**
 * Button that starts linking the user's own GitHub account, which every
 * member does to see previews fetched with their own access.
 *
 * @param props the props passed on to the underlying button.
 * @returns the button.
 */
export function GitHubConnectButton(props: Props<HTMLButtonElement>) {
  const { t } = useTranslation();
  return (
    <OAuthButton buildUrl={userAuthUrl} {...props}>
      {t("Connect")}
    </OAuthButton>
  );
}

/**
 * Button that starts installing the GitHub app on an organization or account,
 * which an admin does so that the app can reach its repositories.
 *
 * @param props the props passed on to the underlying button.
 * @returns the button.
 */
export function GitHubInstallButton(props: Props<HTMLButtonElement>) {
  const { t } = useTranslation();
  return (
    <OAuthButton buildUrl={installUrl} {...props}>
      {t("Install")}
    </OAuthButton>
  );
}

interface OAuthButtonProps extends Props<HTMLButtonElement> {
  /** Builds the GitHub URL to send the user to for the OAuth state. */
  buildUrl: (state: OAuthState) => string;
}

// Stable wrappers, the static methods rely on `this` and so cannot be passed
// unbound.
const userAuthUrl = (state: OAuthState) => GitHubUtils.userAuthUrl(state);
const installUrl = (state: OAuthState) => GitHubUtils.authUrl(state);

/**
 * Button that sends the user to GitHub with a fresh OAuth state.
 *
 * @param props the URL builder and the props passed on to the button.
 * @returns the button.
 */
function OAuthButton({ buildUrl, ...props }: OAuthButtonProps) {
  const team = useCurrentTeam();

  const handleClick = React.useCallback(() => {
    const nonce = generateOAuthStateNonce(GitHubOAuthNonceCookie);
    redirectTo(buildUrl({ teamId: team.id, nonce }));
  }, [buildUrl, team.id]);

  return <Button onClick={handleClick} neutral {...props} />;
}
