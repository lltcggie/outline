import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation, Trans } from "react-i18next";
import { IntegrationService, IntegrationType } from "@shared/types";
import { ConnectedButton } from "~/scenes/Settings/components/ConnectedButton";
import { IntegrationScene } from "~/scenes/Settings/components/IntegrationScene";
import { AvatarSize } from "~/components/Avatar";
import Heading from "~/components/Heading";
import List from "~/components/List";
import ListItem from "~/components/List/Item";
import Notice from "~/components/Notice";
import TeamLogo from "~/components/TeamLogo";
import Text from "~/components/Text";
import Time from "~/components/Time";
import env from "~/env";
import useQuery from "~/hooks/useQuery";
import useStores from "~/hooks/useStores";
import type Integration from "~/models/Integration";
import { AsanaIcon } from "./Icon";
import { AsanaConnectButton } from "./components/AsanaButton";

function Asana() {
  const { integrations, unfurls } = useStores();
  const { t } = useTranslation();
  const query = useQuery();
  const error = query.get("error");
  const appName = env.APP_NAME;

  // Always fetched afresh, as the account is removed on the server when the
  // user revokes the application in Asana, which the client is not told about.
  // Fetching only adds to the store, so an account that is gone is taken out
  // of it here, or it would still be shown as connected.
  React.useEffect(() => {
    void integrations
      .fetchAll({ service: IntegrationService.Asana })
      .then((results) => {
        const ids = new Set(results.map((integration) => integration.id));
        integrations.removeAll(
          (integration) =>
            integration.service === IntegrationService.Asana &&
            integration.type === IntegrationType.LinkedAccount &&
            !ids.has(integration.id)
        );
      });
  }, [integrations]);

  const linkedAccount = integrations.orderedData.find(
    (integration): integration is Integration<IntegrationType.LinkedAccount> =>
      integration.type === IntegrationType.LinkedAccount &&
      integration.service === IntegrationService.Asana
  );
  const account = linkedAccount?.settings?.asana?.account;

  const handleUnlink = React.useCallback(async () => {
    await linkedAccount?.delete();
    // Previews fetched with the account must not remain visible.
    unfurls.clear();
  }, [linkedAccount, unfurls]);

  return (
    <IntegrationScene title="Asana" icon={<AsanaIcon />}>
      <Heading>Asana</Heading>

      {error && (
        <Notice>
          {error === "access_denied" ? (
            <Trans>
              You need to accept the permissions in Asana to connect{" "}
              {{ appName }} to your account. Try again?
            </Trans>
          ) : (
            <Trans>
              Something went wrong while authenticating your request. Please try
              again.
            </Trans>
          )}
        </Notice>
      )}
      {env.ASANA_CLIENT_ID ? (
        <>
          <Text as="p">
            <Trans>
              Link your Asana account to enable previews of Asana tasks and
              projects in documents. Previews are fetched with your own Asana
              permissions and are only shown to you, other members only see what
              their own linked account can access.
            </Trans>
          </Text>
          {linkedAccount ? (
            <List>
              <ListItem
                small
                title={account?.name ?? "Asana"}
                subtitle={
                  <>
                    {account?.email ? <>{account.email} &middot; </> : null}
                    <Trans>Enabled on</Trans>{" "}
                    <Time
                      dateTime={linkedAccount.createdAt}
                      relative={false}
                      format={{ en_US: "MMMM d, y" }}
                    />
                  </>
                }
                image={
                  account?.avatarUrl ? (
                    <TeamLogo src={account.avatarUrl} size={AvatarSize.Large} />
                  ) : (
                    <AsanaIcon size={AvatarSize.Large} />
                  )
                }
                actions={
                  <ConnectedButton
                    onClick={handleUnlink}
                    confirmationMessage={t(
                      "Disconnecting will prevent you from seeing previews of links from Asana in documents. Are you sure?"
                    )}
                  />
                }
              />
            </List>
          ) : (
            <p>
              <AsanaConnectButton icon={<AsanaIcon />} />
            </p>
          )}
        </>
      ) : (
        <Notice>
          <Trans>
            The Asana integration is currently disabled. Please set the
            associated environment variables and restart the server to enable
            the integration.
          </Trans>
        </Notice>
      )}
    </IntegrationScene>
  );
}

export default observer(Asana);
