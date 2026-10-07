import { addDays, endOfDay, subDays } from "date-fns";
import i18next from "i18next";
import type { TFunction } from "i18next";
import { DateFormat, TimeFormat } from "@shared/types";
import { DateTimeFormatter } from "@shared/utils/DateTimeFormatter";
import { dateToExpiry, daysToExpiry } from "./date";

describe("daysToExpiry", () => {
  const instance = i18next.createInstance();

  beforeAll(async () => {
    await instance.init({ lng: "en_US", resources: {} });
  });

  it("should return the number of days until expiry", () => {
    const date = endOfDay(addDays(new Date(), 3)).toISOString();
    expect(daysToExpiry(date, instance.t)).toContain("3");
  });

  it("should return today when expiring today", () => {
    const date = endOfDay(new Date()).toISOString();
    expect(daysToExpiry(date, instance.t)).toEqual("Expires today");
  });

  it("should return expired when in the past", () => {
    const date = subDays(new Date(), 1).toISOString();
    expect(daysToExpiry(date, instance.t)).toEqual("Expired");
  });
});

describe("dateToExpiry", () => {
  // A Wednesday, so that the same week runs from Sunday the 4th to Saturday
  // the 10th.
  const now = new Date(2026, 9, 7, 12, 0);
  const formatter = new DateTimeFormatter({ language: "en_US" });
  const t = vi.fn((key: string, options?: { date: string }) =>
    key.replace("{{ date }}", options?.date ?? "")
  ) as unknown as TFunction;

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("should say expired yesterday", () => {
    expect(
      dateToExpiry(new Date(2026, 9, 6, 12, 0).toISOString(), t, formatter)
    ).toBe("Expired yesterday");
  });

  it("should write out an older expiry date in the user's format", () => {
    expect(
      dateToExpiry(new Date(2026, 9, 4, 12, 0).toISOString(), t, formatter)
    ).toBe("Expired October 4, 2026");
    expect(
      dateToExpiry(
        new Date(2026, 9, 4, 12, 0).toISOString(),
        t,
        new DateTimeFormatter({
          language: "en_US",
          dateFormat: DateFormat.ISO,
          timeFormat: TimeFormat.TwentyFourHour,
        })
      )
    ).toBe("Expired 2026-10-04");
  });

  it("should say expires today and tomorrow", () => {
    expect(
      dateToExpiry(new Date(2026, 9, 7, 18, 0).toISOString(), t, formatter)
    ).toBe("Expires today");
    expect(
      dateToExpiry(new Date(2026, 9, 8, 12, 0).toISOString(), t, formatter)
    ).toBe("Expires tomorrow");
  });

  it("should name the weekday within the same week", () => {
    expect(
      dateToExpiry(new Date(2026, 9, 9, 12, 0).toISOString(), t, formatter)
    ).toBe("Expires Friday");
    expect(
      dateToExpiry(
        new Date(2026, 9, 9, 12, 0).toISOString(),
        t,
        new DateTimeFormatter({ language: "ja_JP" })
      )
    ).toBe("Expires 金曜日");
  });

  it("should write out a later expiry date in the user's format", () => {
    expect(
      dateToExpiry(new Date(2026, 9, 20, 12, 0).toISOString(), t, formatter)
    ).toBe("Expires October 20, 2026");
  });
});
