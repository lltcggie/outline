import { observer } from "mobx-react";
import { PlusIcon } from "outline-icons";
import * as React from "react";
import { useTranslation, Trans } from "react-i18next";
import { IntegrationService, type IntegrationType } from "@shared/types";
import { ConnectedButton } from "~/scenes/Settings/components/ConnectedButton";
import { IntegrationScene } from "~/scenes/Settings/components/IntegrationScene";
import { AvatarSize } from "~/components/Avatar";
import Flex from "~/components/Flex";
import Heading from "~/components/Heading";
import List from "~/components/List";
import ListItem from "~/components/List/Item";
import Notice from "~/components/Notice";
import PlaceholderText from "~/components/PlaceholderText";
import TeamLogo from "~/components/TeamLogo";
import Text from "~/components/Text";
import Time from "~/components/Time";
import env from "~/env";
import useCurrentTeam from "~/hooks/useCurrentTeam";
import usePolicy from "~/hooks/usePolicy";
import useQuery from "~/hooks/useQuery";
import useStores from "~/hooks/useStores";
import type Integration from "~/models/Integration";
import { isTruthyQueryValue } from "~/utils/urls";
import GitHubIcon from "./Icon";
import {
  GitHubConnectButton,
  GitHubInstallButton,
} from "./components/GitHubButton";

function GitHub() {
  const { integrations } = useStores();
  const { t } = useTranslation();
  const team = useCurrentTeam();
  const can = usePolicy(team);
  const query = useQuery();
  const error = query.get("error");
  const installRequest = query.get("install_request");
  const appName = env.APP_NAME;
  const githubAppName = env.GITHUB_APP_NAME;

  // Always fetched afresh, as the account is removed on the server when the
  // user revokes the app in GitHub, which the client is not told about.
  React.useEffect(() => {
    void integrations.fetchService(IntegrationService.GitHub, {
      withRelations: true,
    });
  }, [integrations]);

  const installations = integrations.github;
  const linkedAccount = integrations.githubLinkedAccount;

  return (
    <IntegrationScene title="GitHub" icon={<GitHubIcon />}>
      <Heading>GitHub</Heading>

      {error && (
        <Notice>
          {error === "access_denied" ? (
            <Trans>
              You need to accept the permissions in GitHub to connect{" "}
              {{ appName }} to your account. Try again?
            </Trans>
          ) : error === "duplicate_account" ? (
            <Trans>
              The GitHub account is already linked by another user in this
              workspace.
            </Trans>
          ) : error === "install_forbidden" ? (
            <Trans>
              Only an admin can install the {{ githubAppName }} GitHub app for
              this workspace. Ask an admin to install it from these settings.
            </Trans>
          ) : (
            <Trans>
              Something went wrong while authenticating your request. Please try
              again.
            </Trans>
          )}
        </Notice>
      )}
      {isTruthyQueryValue(installRequest) && (
        <Notice>
          <Trans>
            The owner of GitHub account has been requested to install the{" "}
            {{ githubAppName }} GitHub app. Once approved, previews will be
            shown for respective links.
          </Trans>
        </Notice>
      )}
      {env.GITHUB_CLIENT_ID ? (
        <>
          <Text as="p">
            <Trans>
              Link your GitHub account to enable previews of GitHub issues, pull
              requests and projects in documents. Previews are fetched with your
              own GitHub permissions and are only shown to you, other members
              only see what their own linked account can access.
            </Trans>
          </Text>

          <Heading as="h2">{t("Your account")}</Heading>
          <List>
            <LinkedAccountItem linkedAccount={linkedAccount} />
          </List>

          {installations.length === 0 && !can.createIntegration && (
            <Notice>
              <Trans>
                The {{ githubAppName }} GitHub app has not been installed for
                this workspace yet. Ask an admin to install it on the
                organizations or repositories whose links should be previewed.
              </Trans>
            </Notice>
          )}

          {can.createIntegration && (
            <>
              <Heading as="h2">
                <Flex justify="space-between" auto>
                  {t("Workspace")}
                  {installations.length > 0 && (
                    <GitHubInstallButton icon={<PlusIcon />} />
                  )}
                </Flex>
              </Heading>
              <Text as="p" type="secondary">
                <Trans>
                  Install the {{ githubAppName }} GitHub app on the
                  organizations or repositories whose links members may preview.
                  The app only decides which repositories can be reached at all,
                  each member still sees no more than their own GitHub account
                  can access.
                </Trans>
              </Text>
              {installations.length > 0 ? (
                <List>
                  {installations.map((integration) => (
                    <InstallationItem
                      key={integration.id}
                      integration={integration}
                    />
                  ))}
                </List>
              ) : (
                <p>
                  <GitHubInstallButton icon={<GitHubIcon />} />
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <Notice>
          <Trans>
            The GitHub integration is currently disabled. Please set the
            associated environment variables and restart the server to enable
            the integration.
          </Trans>
        </Notice>
      )}
    </IntegrationScene>
  );
}

interface LinkedAccountItemProps {
  /** The user's linked GitHub account, if any. */
  linkedAccount?: Integration<IntegrationType.LinkedAccount>;
}

const LinkedAccountItem = observer(function LinkedAccountItem_({
  linkedAccount,
}: LinkedAccountItemProps) {
  const { t } = useTranslation();
  const { unfurls } = useStores();
  const account = linkedAccount?.settings?.github?.account;

  const handleUnlink = React.useCallback(async () => {
    await linkedAccount?.delete();
    // Previews fetched with the account must not remain visible.
    unfurls.clear();
  }, [linkedAccount, unfurls]);

  return (
    <ListItem
      small
      title={account?.name ?? "GitHub"}
      subtitle={
        linkedAccount ? (
          <>
            <Trans>Enabled on</Trans>{" "}
            <Time
              dateTime={linkedAccount.createdAt}
              relative={false}
              time={false}
            />
          </>
        ) : (
          t("Not linked")
        )
      }
      image={
        account?.avatarUrl ? (
          <TeamLogo src={account.avatarUrl} size={AvatarSize.Large} />
        ) : (
          <GitHubIcon size={AvatarSize.Large} />
        )
      }
      actions={
        linkedAccount ? (
          <ConnectedButton
            onClick={handleUnlink}
            confirmationMessage={t(
              "Disconnecting will prevent you from seeing previews of links from GitHub in documents. Are you sure?"
            )}
          />
        ) : (
          <GitHubConnectButton />
        )
      }
    />
  );
});

interface InstallationItemProps {
  /** The workspace integration recording an installation of the app. */
  integration: Integration<IntegrationType.Embed>;
}

const InstallationItem = observer(function InstallationItem_({
  integration,
}: InstallationItemProps) {
  const { t } = useTranslation();
  const { unfurls } = useStores();
  const githubAccount = integration.settings?.github?.installation.account;
  const integrationCreatedBy = integration.user?.name;

  const handleDisconnect = React.useCallback(async () => {
    await integration.delete();
    // The app is uninstalled from the organization on the server, so previews
    // of its repositories must not remain visible.
    unfurls.clear();
  }, [integration, unfurls]);

  return (
    <ListItem
      small
      title={githubAccount?.name}
      subtitle={
        integrationCreatedBy ? (
          <>
            <Trans>Enabled by {{ integrationCreatedBy }}</Trans> &middot;{" "}
            <Time
              dateTime={integration.createdAt}
              relative={false}
              time={false}
            />
          </>
        ) : (
          <PlaceholderText />
        )
      }
      image={
        <TeamLogo src={githubAccount?.avatarUrl} size={AvatarSize.Large} />
      }
      actions={
        <ConnectedButton
          onClick={handleDisconnect}
          confirmationMessage={t(
            "Disconnecting will prevent previewing GitHub links from this organization in documents. Are you sure?"
          )}
        />
      }
    />
  );
});

export default observer(GitHub);
