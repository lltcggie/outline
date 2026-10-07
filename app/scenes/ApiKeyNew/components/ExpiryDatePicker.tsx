import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { Calendar } from "@shared/components/Calendar";
import { dateLocale } from "@shared/utils/date";
import Button from "~/components/Button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "~/components/primitives/Popover";
import useDateTimeFormatter from "~/hooks/useDateTimeFormatter";
import useUserLocale from "~/hooks/useUserLocale";

type Props = {
  selectedDate?: Date;
  onSelect: (date: Date) => void;
};

const ExpiryDatePicker = ({ selectedDate, onSelect }: Props) => {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  const userLocale = useUserLocale();
  const locale = dateLocale(userLocale);
  const formatter = useDateTimeFormatter();

  const handleSelect = React.useCallback(
    (date: Date) => {
      setOpen(false);
      onSelect(date);
    },
    [onSelect]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <StyledPopoverButton neutral>
          {selectedDate
            ? formatter.formatDate(selectedDate)
            : t("Choose a date")}
        </StyledPopoverButton>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t("Choose a date")}
        width={280}
        side="right"
        shrink
      >
        <Calendar
          required
          mode="single"
          selected={selectedDate}
          onSelect={handleSelect}
          locale={locale}
          disabled={{ before: new Date() }}
        />
      </PopoverContent>
    </Popover>
  );
};

const StyledPopoverButton = styled(Button)`
  margin-top: 12px;
  min-width: 150px;
`;

export default ExpiryDatePicker;
