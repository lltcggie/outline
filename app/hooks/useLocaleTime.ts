import { useState, useRef, useEffect } from "react";
import { dateLocale, dateToRelative } from "@shared/utils/date";
import useDateTimeFormatter from "~/hooks/useDateTimeFormatter";
import useUserLocale from "~/hooks/useUserLocale";

let callbacks: (() => void)[] = [];

// This is a shared timer that fires every minute, used for
// updating all Time components across the page all at once.
setInterval(() => {
  callbacks.forEach((cb) => cb());
}, 1000 * 60);

function eachMinute(fn: () => void) {
  callbacks.push(fn);

  return () => {
    callbacks = callbacks.filter((cb) => cb !== fn);
  };
}

export type Props = {
  dateTime: string;
  addSuffix?: boolean;
  shorten?: boolean;
  /** Whether to display the time relative to now, e.g. "3 minutes ago". Defaults to true. */
  relative?: boolean;
  /** Whether an absolute date includes the year. Defaults to true. */
  year?: boolean;
  /** Whether an absolute date includes the time of day. Defaults to true. */
  time?: boolean;
};

export const useLocaleTime = ({
  addSuffix,
  dateTime,
  shorten,
  relative,
  year = true,
  time = true,
}: Props) => {
  const userLocale = useUserLocale();
  const formatter = useDateTimeFormatter();
  const [, setMinutesMounted] = useState(0);
  const callback = useRef<() => void>();

  useEffect(() => {
    callback.current = eachMinute(() => {
      setMinutesMounted((state) => ++state);
    });
    return () => {
      if (callback.current) {
        callback.current?.();
      }
    };
  }, []);

  const date = new Date(Date.parse(dateTime));
  const locale = dateLocale(userLocale);
  const relativeContent = dateToRelative(date, {
    addSuffix,
    locale,
    shorten,
  });

  const tooltipContent = formatter.formatDateTime(date);
  const content =
    relative !== false
      ? relativeContent
      : time
        ? formatter.formatDateTime(date, { year })
        : formatter.formatDate(date, { year });

  return {
    content,
    tooltipContent,
  };
};
