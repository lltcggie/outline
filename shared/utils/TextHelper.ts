import type { DateTimeFormatter } from "./DateTimeFormatter";

/** The parts of a user that template variables are replaced from. */
export interface TemplateVariablesUser {
  name: string;
  dateTimeFormatter: DateTimeFormatter;
}

export class TextHelper {
  /**
   * Replaces template variables with the current date, time, and author name.
   *
   * @param text the text to replace the variables in.
   * @param user the user to get the author name and date format from.
   * @returns the text with the variables replaced.
   */
  static replaceTemplateVariables(text: string, user: TemplateVariablesUser) {
    const { dateTimeFormatter } = user;
    const now = new Date();

    return text
      .replace(/{date}/g, dateTimeFormatter.formatDate(now))
      .replace(/{time}/g, dateTimeFormatter.formatTime(now))
      .replace(/{datetime}/g, dateTimeFormatter.formatDateTime(now))
      .replace(/{author}/g, () => user.name);
  }

  /**
   * Returns the length of the text in Unicode code points rather than UTF-16
   * code units, matching the server-side length validation.
   *
   * @param text The text to measure
   * @returns The number of code points in the text
   */
  static codePointLength(text: string): number {
    return Array.from(text).length;
  }

  /**
   * Truncates the text to a maximum number of Unicode code points without
   * splitting surrogate pairs.
   *
   * @param text The text to truncate
   * @param maxLength The maximum number of code points to keep
   * @returns The truncated text
   */
  static truncate(text: string, maxLength: number): string {
    return Array.from(text).slice(0, Math.max(0, maxLength)).join("");
  }
}
