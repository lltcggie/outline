import type { Schema } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { DateTimeFormatter } from "../../utils/DateTimeFormatter";
import Extension from "../lib/Extension";

/**
 * An editor extension that adds commands to insert the current date and time.
 */
export default class DateTime extends Extension {
  get name() {
    return "date_time";
  }

  commands(_options: { schema: Schema }) {
    const { template } = this.editor.props;
    // Read when the command runs so that a change of the user's date format
    // is picked up without rebuilding the editor.
    const formatter = () =>
      this.editor.props.dateTimeFormatter ?? DateTimeFormatter.default;

    return {
      date: (): Command => (state, dispatch) => {
        dispatch?.(
          state.tr.insertText(
            (template ? "{date}" : formatter().formatDate(new Date())) + " "
          )
        );
        return true;
      },
      time: (): Command => (state, dispatch) => {
        dispatch?.(
          state.tr.insertText(
            (template ? "{time}" : formatter().formatTime(new Date())) + " "
          )
        );
        return true;
      },
      datetime: (): Command => (state, dispatch) => {
        dispatch?.(
          state.tr.insertText(
            (template ? "{datetime}" : formatter().formatDateTime(new Date())) +
              " "
          )
        );
        return true;
      },
    };
  }
}
