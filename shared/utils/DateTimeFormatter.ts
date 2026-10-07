import { TeamPreferenceDefaults } from "../constants";
import type { TeamPreferences, UserPreferences } from "../types";
import { DateFormat, TeamPreference, TimeFormat } from "../types";
import { unicodeCLDRtoBCP47 } from "./date";

export interface DateTimeFormatterOptions {
  /** How dates are written out, defaults to the convention of the language. */
  dateFormat?: DateFormat | null;
  /** How times are written out, defaults to the convention of the language. */
  timeFormat?: TimeFormat | null;
  /** The language in CLDR form, e.g. "en_US". Defaults to the runtime locale. */
  language?: string | null;
  /** The IANA time zone dates are displayed in. Defaults to the runtime's. */
  timeZone?: string | null;
}

export interface FormatDateOptions {
  /** Whether to include the year. Defaults to true. */
  year?: boolean;
  /**
   * The IANA time zone to read the calendar date in, overriding the
   * formatter's. A date-only value parsed in another zone is displayed in that
   * same zone so that it does not slip to the previous or next day. Unlike the
   * formatter's own time zone it is not validated: a zone Intl does not know
   * throws a RangeError.
   */
  timeZone?: string;
}

export interface FormatTimeOptions {
  /**
   * The IANA time zone to display the time in, overriding the formatter's.
   * Unlike the formatter's own time zone it is not validated: a zone Intl does
   * not know throws a RangeError.
   */
  timeZone?: string;
}

interface UserLike {
  language?: string | null;
  preferences?: UserPreferences | null;
  timezone?: string | null;
}

type DatePart = "year" | "month" | "day";

/** The order and separator of the numeric date parts of each explicit format. */
const dateLayouts: Record<
  Exclude<DateFormat, DateFormat.Locale>,
  { order: DatePart[]; separator: string }
> = {
  [DateFormat.ISO]: { order: ["year", "month", "day"], separator: "-" },
  [DateFormat.YearMonthDay]: {
    order: ["year", "month", "day"],
    separator: "/",
  },
  [DateFormat.DayMonthYear]: {
    order: ["day", "month", "year"],
    separator: "/",
  },
  [DateFormat.MonthDayYear]: {
    order: ["month", "day", "year"],
    separator: "/",
  },
};

const hourCycles: Partial<Record<TimeFormat, "h23" | "h12">> = {
  [TimeFormat.TwentyFourHour]: "h23",
  [TimeFormat.TwelveHour]: "h12",
};

/**
 * Writes out absolute dates and times following the date and time format a
 * user has chosen, falling back to the conventions of their language. The same
 * formatter is used on the client and the server so that dates read the same
 * wherever they are rendered for a given user.
 */
export class DateTimeFormatter {
  /** A formatter following the runtime locale, for when no user is known. */
  public static readonly default = new DateTimeFormatter();

  /**
   * Creates the formatter for a user, resolving the format from the user's
   * preferences, else the team's, else the team preference defaults. Dates are
   * displayed in the user's time zone, so that the server writes the same
   * date as the user's browser would.
   *
   * @param user The user with their language, time zone and preferences.
   * @param teamPreferences The preferences of the user's team, if known.
   * @returns the formatter.
   */
  public static fromPreferences(
    user: UserLike,
    teamPreferences?: TeamPreferences | null
  ): DateTimeFormatter {
    return new DateTimeFormatter({
      language: user.language,
      timeZone: user.timezone,
      dateFormat:
        user.preferences?.dateFormat ??
        teamPreferences?.dateFormat ??
        TeamPreferenceDefaults[TeamPreference.DateFormat],
      timeFormat:
        user.preferences?.timeFormat ??
        teamPreferences?.timeFormat ??
        TeamPreferenceDefaults[TeamPreference.TimeFormat],
    });
  }

  public readonly dateFormat: DateFormat;

  public readonly timeFormat: TimeFormat;

  constructor({
    dateFormat,
    timeFormat,
    language,
    timeZone,
  }: DateTimeFormatterOptions = {}) {
    this.dateFormat = dateFormat ?? DateFormat.Locale;
    this.timeFormat = timeFormat ?? TimeFormat.Locale;
    this.locale = language
      ? DateTimeFormatter.supported({}, unicodeCLDRtoBCP47(language))
      : undefined;
    this.timeZone = timeZone
      ? DateTimeFormatter.supported({ timeZone })
      : undefined;
  }

  /**
   * Formats the date part of a Date, e.g. "October 7, 2026" or "2026-10-07".
   *
   * @param date The date to format.
   * @param options Whether to include the year, and the time zone to read the
   * date in.
   * @returns the formatted date.
   */
  public formatDate(
    date: Date,
    { year = true, timeZone }: FormatDateOptions = {}
  ): string {
    if (this.dateFormat === DateFormat.Locale) {
      return this.intl({ ...this.dateOptions(year), timeZone }).format(date);
    }

    const { order, separator } = dateLayouts[this.dateFormat];
    const parts = this.intl(
      { year: "numeric", month: "2-digit", day: "2-digit", timeZone },
      "en-US"
    ).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));

    return order
      .filter((part) => year || part !== "year")
      .map((part) => values.get(part))
      .join(separator);
  }

  /**
   * Formats the time part of a Date, e.g. "4:15 PM" or "16:15".
   *
   * @param date The date to format.
   * @param options The time zone to display the time in.
   * @returns the formatted time.
   */
  public formatTime(date: Date, { timeZone }: FormatTimeOptions = {}): string {
    return this.intl({ ...this.timeOptions(), timeZone }).format(date);
  }

  /**
   * Formats both the date and time of a Date, e.g. "October 7, 2026 at 4:15 PM"
   * or "2026-10-07 16:15".
   *
   * @param date The date to format.
   * @param options Whether to include the year, and the time zone to display
   * the date and time in.
   * @returns the formatted date and time.
   */
  public formatDateTime(
    date: Date,
    { year = true, timeZone }: FormatDateOptions = {}
  ): string {
    if (this.dateFormat === DateFormat.Locale) {
      return this.intl({
        ...this.dateOptions(year),
        ...this.timeOptions(),
        timeZone,
      }).format(date);
    }
    const formattedDate = this.formatDate(date, { year, timeZone });
    const formattedTime = this.formatTime(date, { timeZone });
    return `${formattedDate} ${formattedTime}`;
  }

  /**
   * Formats the day of the week of a Date in the user's language, e.g.
   * "Tuesday".
   *
   * @param date The date to format.
   * @returns the name of the weekday.
   */
  public formatWeekday(date: Date): string {
    return this.intl({ weekday: "long" }).format(date);
  }

  private readonly locale: string | undefined;

  private readonly timeZone: string | undefined;

  /** Intl formatters are expensive to construct, so one is kept per shape. */
  private readonly intlCache = new Map<string, Intl.DateTimeFormat>();

  private dateOptions(year: boolean): Intl.DateTimeFormatOptions {
    return year
      ? { year: "numeric", month: "long", day: "numeric" }
      : { month: "short", day: "numeric" };
  }

  private timeOptions(): Intl.DateTimeFormatOptions {
    return {
      hour: "numeric",
      minute: "numeric",
      hourCycle: hourCycles[this.timeFormat],
    };
  }

  /**
   * Returns the cached Intl formatter for the options, in the formatter's
   * time zone unless the options name one.
   */
  private intl(
    options: Intl.DateTimeFormatOptions,
    locale = this.locale
  ): Intl.DateTimeFormat {
    const resolved = {
      ...options,
      timeZone: options.timeZone ?? this.timeZone,
    };
    const key = `${locale}:${JSON.stringify(resolved)}`;
    let formatter = this.intlCache.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, resolved);
      this.intlCache.set(key, formatter);
    }
    return formatter;
  }

  /**
   * Returns the locale tag or the time zone of the options when Intl accepts
   * them, else undefined so that the runtime's own are used instead of
   * throwing on every format call.
   */
  private static supported(
    options: Intl.DateTimeFormatOptions,
    locale?: string
  ): string | undefined {
    try {
      new Intl.DateTimeFormat(locale, options);
      return locale ?? options.timeZone;
    } catch {
      return undefined;
    }
  }
}
