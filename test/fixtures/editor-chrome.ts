import type { InkbookEditorChromeProps } from "../../src/rendering/ui/editor-chrome";

const noop = (): void => undefined;

export function createEditorChromeProps(ownerDocument: Document): InkbookEditorChromeProps {
  return {
    layout: "wide",
    onToolbarAction: noop,
    ownerDocument,
    renderIcon: noop,
    selectionArea: "rectangle",
    selectedShape: "line",
    shapeIcon: { arrowEnd: "arrow", arrowStart: "none", coordinateDimension: "2d" },
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
