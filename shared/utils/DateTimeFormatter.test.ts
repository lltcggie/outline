import { DateFormat, TimeFormat } from "../types";
import { DateTimeFormatter } from "./DateTimeFormatter";

describe("DateTimeFormatter", () => {
  const date = new Date(2026, 9, 7, 16, 15);

  describe("fromPreferences", () => {
    it("should prefer the user's format over the team's", () => {
      const formatter = DateTimeFormatter.fromPreferences(
        {
          language: "en_US",
          preferences: { dateFormat: DateFormat.ISO },
        },
        {
          dateFormat: DateFormat.DayMonthYear,
          timeFormat: TimeFormat.TwentyFourHour,
        }
      );

      expect(formatter.dateFormat).toBe(DateFormat.ISO);
      expect(formatter.timeFormat).toBe(TimeFormat.TwentyFourHour);
    });

    it("should fall back to the language default", () => {
      const formatter = DateTimeFormatter.fromPreferences({
        language: "en_US",
      });

      expect(formatter.dateFormat).toBe(DateFormat.Locale);
      expect(formatter.timeFormat).toBe(TimeFormat.Locale);
    });

    it("should display dates in the user's time zone", () => {
      const formatter = DateTimeFormatter.fromPreferences({
        language: "en_US",
        timezone: "Asia/Tokyo",
        preferences: {
          dateFormat: DateFormat.ISO,
          timeFormat: TimeFormat.TwentyFourHour,
        },
      });
      // 22:30 UTC on the 7th is 07:30 on the 8th in Tokyo.
      const utc = new Date(Date.UTC(2026, 9, 7, 22, 30));

      expect(formatter.formatDateTime(utc)).toBe("2026-10-08 07:30");
      expect(formatter.formatWeekday(utc)).toBe("Thursday");
    });
  });

  describe("time zone", () => {
    const utc = new Date(Date.UTC(2026, 9, 7, 22, 30));

    it("should apply to the language default as well", () => {
      const formatter = new DateTimeFormatter({
        language: "ja_JP",
        timeZone: "Asia/Tokyo",
      });

      expect(formatter.formatDateTime(utc)).toBe("2026年10月8日 7:30");
    });

    it("should be overridable per call for times", () => {
      const formatter = new DateTimeFormatter({
        language: "en_US",
        timeZone: "Asia/Tokyo",
        timeFormat: TimeFormat.TwentyFourHour,
      });

      expect(formatter.formatTime(utc)).toBe("07:30");
      expect(formatter.formatTime(utc, { timeZone: "UTC" })).toBe("22:30");
    });

    it("should be overridable per call for dates", () => {
      const formatter = new DateTimeFormatter({
        language: "en_US",
        timeZone: "Asia/Tokyo",
      });

      expect(formatter.formatDate(utc)).toBe("October 8, 2026");
      expect(formatter.formatDate(utc, { timeZone: "UTC" })).toBe(
        "October 7, 2026"
      );
      expect(
        new DateTimeFormatter({
          language: "en_US",
          timeZone: "Asia/Tokyo",
          dateFormat: DateFormat.ISO,
        }).formatDate(utc, { timeZone: "UTC" })
      ).toBe("2026-10-07");
    });

    it("should be overridable per call for dates with times", () => {
      const formatter = new DateTimeFormatter({
        language: "en_US",
        timeZone: "Asia/Tokyo",
        timeFormat: TimeFormat.TwentyFourHour,
      });

      expect(formatter.formatDateTime(utc, { timeZone: "UTC" })).toContain(
        "October 7, 2026"
      );
      expect(formatter.formatDateTime(utc, { timeZone: "UTC" })).toContain(
        "22:30"
      );
      expect(
        new DateTimeFormatter({
          language: "en_US",
          timeZone: "Asia/Tokyo",
          dateFormat: DateFormat.ISO,
          timeFormat: TimeFormat.TwentyFourHour,
        }).formatDateTime(utc, { timeZone: "UTC" })
      ).toBe("2026-10-07 22:30");
    });

    it("should ignore an invalid time zone", () => {
      const formatter = new DateTimeFormatter({
        language: "en_US",
        timeZone: "Mars/Olympus_Mons",
      });

      expect(typeof formatter.formatDateTime(utc)).toBe("string");
    });
  });

  describe("language default", () => {
    it("should follow the conventions of English", () => {
      const formatter = new DateTimeFormatter({ language: "en_US" });

      expect(formatter.formatDate(date)).toBe("October 7, 2026");
      expect(formatter.formatDate(date, { year: false })).toBe("Oct 7");
      expect(formatter.formatTime(date)).toBe("4:15 PM");
      expect(formatter.formatWeekday(date)).toBe("Wednesday");
      expect(formatter.formatDateTime(date)).toContain("October 7, 2026");
      expect(formatter.formatDateTime(date)).toContain("4:15 PM");
      expect(formatter.formatDateTime(date, { year: false })).toBe(
        "Oct 7, 4:15 PM"
      );
    });

    it("should follow the conventions of Japanese", () => {
      const formatter = new DateTimeFormatter({ language: "ja_JP" });

      expect(formatter.formatDate(date)).toBe("2026年10月7日");
      expect(formatter.formatDate(date, { year: false })).toBe("10月7日");
      expect(formatter.formatTime(date)).toBe("16:15");
      expect(formatter.formatWeekday(date)).toBe("水曜日");
      expect(formatter.formatDateTime(date)).toBe("2026年10月7日 16:15");
    });

    it("should not throw for an invalid language", () => {
      const formatter = new DateTimeFormatter({ language: "!!" });

      expect(typeof formatter.formatDateTime(date)).toBe("string");
    });
  });

  describe("explicit formats", () => {
    it("should write ISO dates with a 24-hour clock", () => {
      const formatter = new DateTimeFormatter({
        language: "en_US",
        dateFormat: DateFormat.ISO,
        timeFormat: TimeFormat.TwentyFourHour,
      });

      expect(formatter.formatDate(date)).toBe("2026-10-07");
      expect(formatter.formatDate(date, { year: false })).toBe("10-07");
      expect(formatter.formatTime(date)).toBe("16:15");
      expect(formatter.formatDateTime(date)).toBe("2026-10-07 16:15");
      expect(formatter.formatDateTime(date, { year: false })).toBe(
        "10-07 16:15"
      );
    });

    it("should write slash separated dates regardless of language", () => {
      expect(
        new DateTimeFormatter({
          language: "ja_JP",
          dateFormat: DateFormat.YearMonthDay,
        }).formatDate(date)
      ).toBe("2026/10/07");
      expect(
        new DateTimeFormatter({
          language: "en_US",
          dateFormat: DateFormat.DayMonthYear,
        }).formatDate(date)
      ).toBe("07/10/2026");
      expect(
        new DateTimeFormatter({
          language: "de_DE",
          dateFormat: DateFormat.MonthDayYear,
        }).formatDate(date)
      ).toBe("10/07/2026");
    });

    it("should write the day period of the language on a 12-hour clock", () => {
      expect(
        new DateTimeFormatter({
          language: "ja_JP",
          timeFormat: TimeFormat.TwelveHour,
        }).formatTime(date)
      ).toBe("午後4:15");
      expect(
        new DateTimeFormatter({
          language: "de_DE",
          timeFormat: TimeFormat.TwentyFourHour,
        }).formatTime(date)
      ).toBe("16:15");
    });

    it("should combine the language's date with an explicit time format", () => {
      const formatter = new DateTimeFormatter({
        language: "en_US",
        timeFormat: TimeFormat.TwentyFourHour,
      });

      expect(formatter.formatDateTime(date)).toContain("October 7, 2026");
      expect(formatter.formatDateTime(date)).toContain("16:15");
    });

    it("should display the time in another time zone", () => {
      const formatter = new DateTimeFormatter({
        language: "en_US",
        timeFormat: TimeFormat.TwentyFourHour,
      });
      const utc = new Date(Date.UTC(2026, 9, 7, 7, 15));

      expect(formatter.formatTime(utc, { timeZone: "Asia/Tokyo" })).toBe(
        "16:15"
      );
    });
  });
});
