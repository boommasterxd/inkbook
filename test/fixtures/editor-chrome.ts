import type { InkbookEditorChromeProps } from "../../src/rendering/ui/editor-chrome";

const noop = (): void => undefined;

export function createEditorChromeProps(ownerDocument: Document): InkbookEditorChromeProps {
  return {
    background: { spacing: null, type: "none" },
    callbacks: {
      onBackgroundSpacingChange: noop,
      onBackgroundTypeChange: noop,
      onFlyoutClose: noop,
      onOverflowAction: noop,
      onShapeChange: noop,
      onStyleChange: noop,
    },
    canvasInput: null,
    layout: "wide",
    onToolbarAction: noop,
    ownerDocument,
    overflowMenu: {
      arrange: {
        "bring-forward": false,
        "bring-to-front": false,
        "send-backward": false,
        "send-to-back": false,
      },
      canEraseAll: false,
      hasSelection: false,
    },
    renderIcon: noop,
    selectedShape: "line",
    styleControls: [],
    styleIcon: { fillColor: null, fillOpacity: 0, outlineColor: null, outlineStyle: "solid" },
    toolbarState: {
      activeTool: "draw",
      canPaste: false,
      canRedo: false,
      canUndo: false,
      fingerDrawingAvailable: false,
      fingerDrawingEnabled: false,
      hasSelection: false,
      openFlyout: null,
    },
  };
}
