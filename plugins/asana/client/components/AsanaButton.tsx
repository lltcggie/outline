import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { errToString } from "@shared/utils/error";
import Button, { type Props } from "~/components/Button";
import { client } from "~/utils/ApiClient";
import { redirectTo } from "~/utils/urls";

/**
 * Button that starts linking the user's own Asana account.
 *
 * @param props the props passed on to the underlying button.
 * @returns the button, disabled while the authorization is being started.
 */
export function AsanaConnectButton(props: Props<"button">) {
  const { t } = useTranslation();
  const [connecting, setConnecting] = React.useState(false);

  const handleConnect = React.useCallback(async () => {
    setConnecting(true);
    try {
      const res = await client.post("/asana.authorize");
      redirectTo(res.data.redirectUrl);
    } catch (err) {
      toast.error(errToString(err));
      setConnecting(false);
    }
  }, []);

  return (
    <Button onClick={handleConnect} disabled={connecting} neutral {...props}>
      {connecting ? `${t("Connecting")}…` : t("Connect")}
    </Button>
  );
}
