import { DateTimeFormatter } from "@shared/utils/DateTimeFormatter";
import useCurrentUser from "./useCurrentUser";

/**
 * Returns the formatter that writes out absolute dates and times the way the
 * signed-in user has chosen to see them. Without a signed-in user the dates
 * follow the conventions of the browser's locale.
 *
 * @returns the date and time formatter.
 */
export default function useDateTimeFormatter(): DateTimeFormatter {
  return (
    useCurrentUser({ rejectOnEmpty: false })?.dateTimeFormatter ??
    DateTimeFormatter.default
  );
}
