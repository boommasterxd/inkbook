import { vi } from "vitest";
import type { SelectionEdgeAutoScroller } from "../../../src/obsidian/embeds/active-editor/selection-edge-scroll";
import type { SelectionEdgeDragPort } from "../../../src/obsidian/embeds/active-editor/selection-preview-contracts";

export function createSelectionEdgePreview(
  scroller: Pick<SelectionEdgeAutoScroller, "finish" | "update">,
): { readonly port: SelectionEdgeDragPort; readonly refresh: () => void } {
  let refresh: (() => void) | undefined;
  return {
    refresh: () => refresh?.(),
    port: {
      begin: (callback) => {
        refresh = callback;
      },
      finish: () => scroller.finish(),
      stop: () => scroller.finish(),
      update: (point) => scroller.update(point),
      updatePreviewBottom: vi.fn(),
    },
  };
}
