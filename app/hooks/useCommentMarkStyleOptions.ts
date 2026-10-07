import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CommentMarkStyle } from "@shared/types";
import type { Option } from "~/components/InputSelect";

/**
 * Returns the select options for choosing how text with inline comments is
 * highlighted, shared by the workspace and user preference screens.
 *
 * @returns The translated options, one per comment mark style
 */
export default function useCommentMarkStyleOptions(): Option[] {
  const { t } = useTranslation();

  return useMemo(
    () =>
      [
        {
          type: "item",
          label: t("Underline"),
          value: CommentMarkStyle.Underline,
        },
        {
          type: "item",
          label: t("Highlight"),
          value: CommentMarkStyle.Highlight,
        },
      ] satisfies Option[],
    [t]
  );
}
