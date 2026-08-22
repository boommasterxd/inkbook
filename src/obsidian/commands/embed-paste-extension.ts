import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";

import { EmbedPasteController } from "./embed-paste";
import { eventPathHasClass } from "./event-path";

function isInsideInkbook(event: ClipboardEvent): boolean {
  return eventPathHasClass(event, "inkbook-root");
}

export function createEmbedPasteExtension(controller: EmbedPasteController): Extension {
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const clipboardText = event.clipboardData?.getData("text/plain");
      const info = view.state.field(editorInfoField, false);
      if (clipboardText === undefined || info?.editor === undefined || info.file === null) {
        return false;
      }
      const request = {
        clipboardText,
        editor: info.editor,
        insideInkWidget: isInsideInkbook(event),
        sourcePath: info.file.path,
      };
      if (!controller.canHandle(request)) return false;
      event.preventDefault();
      void controller.paste(request);
      return true;
    },
  });
}
