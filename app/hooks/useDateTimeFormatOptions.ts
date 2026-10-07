import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DateFormat, TimeFormat } from "@shared/types";
import { DateTimeFormatter } from "@shared/utils/DateTimeFormatter";
import type { Option } from "~/components/InputSelect";
import useUserLocale from "./useUserLocale";

/**
 * Returns the select options for choosing how dates and times are written
 * out, shared by the workspace and user preference screens. Each option shows
 * the current date or time in that format as an example.
 *
 * @returns the translated options for the date format and the time format.
 */
export default function useDateTimeFormatOptions(): {
  dateFormatOptions: Option[];
  timeFormatOptions: Option[];
} {
  const { t } = useTranslation();
  const language = useUserLocale();

  return useMemo(() => {
    const now = new Date();

    const dateFormats: [DateFormat, string][] = [
      [DateFormat.Locale, t("Language default")],
      [DateFormat.ISO, t("Year-month-day")],
      [DateFormat.YearMonthDay, t("Year/month/day")],
      [DateFormat.DayMonthYear, t("Day/month/year")],
      [DateFormat.MonthDayYear, t("Month/day/year")],
    ];
    const timeFormats: [TimeFormat, string][] = [
      [TimeFormat.Locale, t("Language default")],
      [TimeFormat.TwentyFourHour, t("24-hour")],
      [TimeFormat.TwelveHour, t("12-hour")],
    ];

    return {
      dateFormatOptions: dateFormats.map(([dateFormat, label]) => ({
        type: "item",
        label,
        value: dateFormat,
        description: new DateTimeFormatter({ dateFormat, language }).formatDate(
          now
        ),
      })),
      timeFormatOptions: timeFormats.map(([timeFormat, label]) => ({
        type: "item",
        label,
        value: timeFormat,
        description: new DateTimeFormatter({ timeFormat, language }).formatTime(
          now
        ),
      })),
    };
  }, [t, language]);
}
