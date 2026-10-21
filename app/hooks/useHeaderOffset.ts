import { useEffect } from "react";
import { HEADER_HEIGHT } from "@shared/constants";
import useEditingFocus from "./useEditingFocus";

// Headers currently publishing the variable. Split view mounts one per pane,
// and the variable must outlive all but the last of them.
let mountedHeaders = 0;

/**
 * Publishes the document header's current height as the `--header-offset` CSS
 * variable on the document element, so that sticky editor UI (table headers,
 * block toolbar, find panel) can sit below it. The variable drops to zero while
 * the header is hidden in editing focus mode and is removed when the last
 * header unmounts.
 *
 * @returns whether the header is currently hidden for editing focus.
 */
export default function useHeaderOffset(): boolean {
  const isEditingFocus = useEditingFocus();

  useEffect(() => {
    mountedHeaders += 1;
    return () => {
      mountedHeaders -= 1;
      if (mountedHeaders === 0) {
        window.document.documentElement.style.removeProperty("--header-offset");
      }
    };
  }, []);

  useEffect(() => {
    window.document.documentElement.style.setProperty(
      "--header-offset",
      isEditingFocus ? "0px" : `${HEADER_HEIGHT}px`
    );
  }, [isEditingFocus]);

  return isEditingFocus;
}
