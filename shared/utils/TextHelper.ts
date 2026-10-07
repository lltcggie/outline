import type { DateTimeFormatter } from "./DateTimeFormatter";

/** The parts of a user that template variables are replaced from. */
export interface TemplateVariablesUser {
  name: string;
  dateTimeFormatter: DateTimeFormatter;
}

export class TextHelper {
  /**
   * Replaces template variables in the given text with the current date and time.
   *
   * @param text The text to replace the variables in
   * @param user The user to get the name and date format from
   * @returns The text with the variables replaced
   */
  static replaceTemplateVariables(text: string, user: TemplateVariablesUser) {
    const { dateTimeFormatter } = user;
    const now = new Date();

    return text
      .replace(/{date}/g, dateTimeFormatter.formatDate(now))
      .replace(/{time}/g, dateTimeFormatter.formatTime(now))
      .replace(/{datetime}/g, dateTimeFormatter.formatDateTime(now))
      .replace(/{author}/g, user.name);
  }
}
