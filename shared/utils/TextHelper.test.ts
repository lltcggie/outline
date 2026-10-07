import { DateFormat, TimeFormat } from "../types";
import { DateTimeFormatter } from "./DateTimeFormatter";
import { TextHelper } from "./TextHelper";

describe("TextHelper", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2021-01-01T00:00:00.000Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  describe("replaceTemplateVariables", () => {
    const user = {
      name: "John Doe",
      dateTimeFormatter: new DateTimeFormatter({ language: "en" }),
    };

    it("should replace {time} with current time", async () => {
      const result = TextHelper.replaceTemplateVariables("Hello {time}", user);

      expect(result).toBe("Hello 12:00 AM");
    });

    it("should replace {date} with current date", async () => {
      const result = TextHelper.replaceTemplateVariables("Hello {date}", user);

      expect(result).toBe("Hello January 1, 2021");
    });

    it("should follow the user's date and time format", async () => {
      const result = TextHelper.replaceTemplateVariables(
        "{date} {time} {datetime}",
        {
          ...user,
          dateTimeFormatter: new DateTimeFormatter({
            language: "en",
            dateFormat: DateFormat.ISO,
            timeFormat: TimeFormat.TwentyFourHour,
          }),
        }
      );

      expect(result).toBe("2021-01-01 00:00 2021-01-01 00:00");
    });
  });
});
