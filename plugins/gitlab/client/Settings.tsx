import { uniqBy } from "es-toolkit/compat";
import { observer } from "mobx-react";
import { PlusIcon } from "outline-icons";
import * as React from "react";
import { useTranslation, Trans } from "react-i18next";
import { toast } from "sonner";
import { IntegrationService, type IntegrationType } from "@shared/types";
import { errToString } from "@shared/utils/error";
import { ConnectedButton } from "~/scenes/Settings/components/ConnectedButton";
import { IntegrationScene } from "~/scenes/Settings/components/IntegrationScene";
import { AvatarSize } from "~/components/Avatar";
import Button from "~/components/Button";
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
import { client } from "~/utils/ApiClient";
import { isTruthyQueryValue, redirectTo } from "~/utils/urls";
import { GitLabUtils } from "../shared/GitLabUtils";
import GitLabIcon from "./components/Icon";
import { GitLabConnectButton } from "./components/GitLabButton";

function GitLab() {
  const { integrations } = useStores();
  const { t } = useTranslation();
  const team = useCurrentTeam();
  const can = usePolicy(team);
  const query = useQuery();
  const error = query.get("error");
  const installRequest = query.get("install_request");
  const appName = env.APP_NAME;

  React.useEffect(() => {
    void integrations.fetchAll({
      service: IntegrationService.GitLab,
      withRelations: true,
    });
  }, [integrations]);

  const workspaceIntegrations = integrations.gitlab;
  const linkedAccounts = integrations.gitlabLinkedAccounts;

  // A previous version could connect the same instance several times, while
  // an account is linked once per instance.
  const connectedIntegrations = uniqBy(
    integrations.gitlabConnected,
    (integration) =>
      GitLabUtils.normalizeInstanceUrl(integration.settings?.gitlab?.url)
  );

  return (
    <IntegrationScene title="GitLab" icon={<GitLabIcon />}>
      <Heading>GitLab</Heading>

      {error && (
        <Notice>
          {error === "access_denied" ? (
            <Trans>
              You need to accept the permissions in GitLab to connect{" "}
              {{ appName }} to your account. Try again?
            </Trans>
          ) : error === "duplicate_account" ? (
            <Trans>
              The GitLab account is already linked by another user in this
              workspace.
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
            The owner of GitLab account has been requested to install the
            application. Once approved, the connection will be completed.
          </Trans>
        </Notice>
      )}
      <Text as="p">
        <Trans>
          Link your GitLab account to enable previews of GitLab issues, merge
          requests and projects in documents. Previews are fetched with your own
          GitLab permissions and are only shown to you, other members only see
          what their own linked account can access.
        </Trans>
      </Text>

      {connectedIntegrations.length > 0 ? (
        <>
          <Heading as="h2">{t("Your account")}</Heading>
          <List>
            {connectedIntegrations.map((integration) => (
              <LinkedAccountItem
                key={integration.id}
                integration={integration}
                linkedAccount={linkedAccounts.find((linked) =>
                  GitLabUtils.isSameInstance(
                    linked.settings?.gitlab?.url,
                    integration.settings?.gitlab?.url
                  )
                )}
              />
            ))}
          </List>
        </>
      ) : !can.createIntegration ? (
        <Notice>
          <Trans>
            GitLab has not been connected to this workspace yet. Ask an admin to
            connect it.
          </Trans>
        </Notice>
      ) : null}

      {can.createIntegration &&
        (workspaceIntegrations.length > 0 ? (
          <>
            <Heading as="h2">
              <Flex justify="space-between" auto>
                {t("Workspace")}
                <GitLabConnectButton icon={<PlusIcon />} />
              </Flex>
            </Heading>
            <List>
              {workspaceIntegrations.map((integration) => (
                <WorkspaceIntegrationItem
                  key={integration.id}
                  integration={integration}
                />
              ))}
            </List>
          </>
        ) : (
          <p>
            <GitLabConnectButton icon={<GitLabIcon />} />
          </p>
        ))}
    </IntegrationScene>
  );
}

interface LinkedAccountItemProps {
  /** The workspace integration the account is linked through. */
  integration: Integration<IntegrationType.Embed>;
  /** The user's linked account for the integration's instance, if any. */
  linkedAccount?: Integration<IntegrationType.LinkedAccount>;
}

const LinkedAccountItem = observer(function LinkedAccountItem_({
  integration,
  linkedAccount,
}: LinkedAccountItemProps) {
  const { t } = useTranslation();
  const { unfurls } = useStores();
  const [linking, handleLink] = useAuthorize(integration);
  const instanceUrl =
    integration.settings?.gitlab?.url ?? GitLabUtils.defaultGitlabUrl;
  const account = linkedAccount?.settings?.gitlab?.account;

  const handleUnlink = React.useCallback(async () => {
    await linkedAccount?.delete();
    // Previews fetched with the account must not remain visible.
    unfurls.clear();
  }, [linkedAccount, unfurls]);

  return (
    <ListItem
      small
      title={account?.name ?? instanceUrl}
      subtitle={account ? instanceUrl : t("Not linked")}
      image={
        account ? (
          <TeamLogo src={account.avatarUrl} size={AvatarSize.Large} />
        ) : (
          <GitLabIcon size={AvatarSize.Large} />
        )
      }
      actions={
        linkedAccount ? (
          <ConnectedButton
            onClick={handleUnlink}
            confirmationMessage={t(
              "Disconnecting will prevent you from seeing previews of links from GitLab in documents. Are you sure?"
            )}
          />
        ) : (
          <Button onClick={handleLink} disabled={linking} neutral>
            {linking ? `${t("Connecting")}…` : t("Connect")}
          </Button>
        )
      }
    />
  );
});

interface WorkspaceIntegrationItemProps {
  /** The workspace integration configuring a GitLab instance. */
  integration: Integration<IntegrationType.Embed>;
}

const WorkspaceIntegrationItem = observer(function WorkspaceIntegrationItem_({
  integration,
}: WorkspaceIntegrationItemProps) {
  const { t } = useTranslation();
  const { unfurls } = useStores();
  const [authorizing, handleAuthorize] = useAuthorize(integration);
  const integrationCreatedBy = integration.user?.name;
  const isPending = !!integration.settings?.gitlab?.pending;

  const handleDisconnect = React.useCallback(async () => {
    await integration.delete();
    // The accounts linked through the integration are removed with it on the
    // server, so previews fetched with them must not remain visible. Their
    // list items disappear with the instance, so the store needs no change.
    unfurls.clear();
  }, [integration, unfurls]);

  return (
    <ListItem
      small
      title={integration.settings?.gitlab?.url ?? t("GitLab Cloud")}
      subtitle={
        isPending ? (
          t("Setup not completed, authorize with GitLab to finish connecting")
        ) : integrationCreatedBy ? (
          <>
            <Trans>Enabled by {{ integrationCreatedBy }}</Trans> &middot;{" "}
            <Time
              dateTime={integration.createdAt}
              relative={false}
              format={{ en_US: "MMMM d, y" }}
            />
          </>
        ) : (
          <PlaceholderText />
        )
      }
      image={<GitLabIcon size={AvatarSize.Large} />}
      actions={
        <Flex gap={8}>
          {isPending && (
            <Button onClick={handleAuthorize} disabled={authorizing} neutral>
              {authorizing ? `${t("Connecting")}…` : t("Authorize")}
            </Button>
          )}
          <ConnectedButton
            onClick={handleDisconnect}
            confirmationMessage={t(
              "Disconnecting will remove the GitLab accounts linked by all members and prevent previewing links from GitLab in documents. Are you sure?"
            )}
          />
        </Flex>
      }
    />
  );
});

/**
 * Starts authorizing with the OAuth application of a workspace integration,
 * which links the user's own account and completes connecting the instance.
 *
 * @param integration the workspace integration to authorize with.
 * @returns whether authorization is starting, and a handler that starts it.
 */
function useAuthorize(
  integration: Integration<IntegrationType.Embed>
): [boolean, () => Promise<void>] {
  const [authorizing, setAuthorizing] = React.useState(false);

  const handleAuthorize = React.useCallback(async () => {
    setAuthorizing(true);
    try {
      const res = await client.post("/gitlab.authorize", {
        integrationId: integration.id,
      });
      redirectTo(res.data.redirectUrl);
    } catch (err) {
      toast.error(errToString(err));
      setAuthorizing(false);
    }
  }, [integration.id]);

  return [authorizing, handleAuthorize];
}

export default observer(GitLab);
