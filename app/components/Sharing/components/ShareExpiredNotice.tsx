import { observer } from "mobx-react";
import { useTranslation } from "react-i18next";
import styled, { useTheme } from "styled-components";
import { s } from "@shared/styles";
import ButtonLink from "~/components/ButtonLink";
import Text from "~/components/Text";
import type Share from "~/models/Share";
import useDateTimeFormatter from "~/hooks/useDateTimeFormatter";
import usePolicy from "~/hooks/usePolicy";
import { ShareNotice, StyledInfoIcon } from ".";

interface Props {
  /** The share to display a warning for, if its link has expired. */
  share: Share | null | undefined;
  /** Called when the user chooses to update the expiry. */
  onUpdate: () => void;
}

/**
 * A warning that the link of a published share has expired.
 */
export const ShareExpiredNotice = observer(function ShareExpiredNotice({
  share,
  onUpdate,
}: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const formatter = useDateTimeFormatter();
  const can = usePolicy(share);

  if (!share?.published || !share.expiresAt || !share.isExpired) {
    return null;
  }

  return (
    <ShareNotice role="status">
      <StyledInfoIcon color={theme.textTertiary} />
      <Text type="tertiary" size="xsmall">
        {t("This link expired on {{ date }} and can no longer be accessed.", {
          date: formatter.formatDate(new Date(share.expiresAt)),
        })}
        {can.update && (
          <>
            {" "}
            <UpdateLink type="button" onClick={onUpdate}>
              {t("Update expiry")}
            </UpdateLink>
          </>
        )}
      </Text>
    </ShareNotice>
  );
});

const UpdateLink = styled(ButtonLink)`
  font: inherit;
  color: ${s("textSecondary")};
  text-decoration: underline;
`;
