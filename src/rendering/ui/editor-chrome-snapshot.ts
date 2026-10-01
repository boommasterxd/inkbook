import type { ColorV1 } from "../../domain/schema/public";
import type { InkbookEditorChromeProps } from "./editor-chrome-types";

export function sameEditorChromeProps(
  left: InkbookEditorChromeProps,
  right: InkbookEditorChromeProps,
): boolean {
  return (
    left.onToolbarAction === right.onToolbarAction &&
    left.ownerDocument === right.ownerDocument &&
    left.renderIcon === right.renderIcon &&
    left.layout === right.layout &&
    (left.leftHanded ?? false) === (right.leftHanded ?? false) &&
    left.selectionArea === right.selectionArea &&
    left.selectedShape === right.selectedShape &&
    left.shapeIcon.arrowStart === right.shapeIcon.arrowStart &&
    left.shapeIcon.arrowEnd === right.shapeIcon.arrowEnd &&
    left.shapeIcon.coordinateDimension === right.shapeIcon.coordinateDimension &&
    sameToolbarState(left, right) &&
    sameStyleIcon(left, right)
  );
}

export function editorChromeLayoutKey(props: InkbookEditorChromeProps): string {
  const state = props.toolbarState;
  return [
    props.layout,
    props.leftHanded === true ? "left" : "right",
    state.fingerDrawingAvailable ? "finger" : "no-finger",
    state.hasSelection ? "selection" : "no-selection",
    state.pasteVisible ? "paste" : "no-paste",
  ].join(":");
}

function sameToolbarState(
  left: InkbookEditorChromeProps,
  right: InkbookEditorChromeProps,
): boolean {
  const a = left.toolbarState;
  const b = right.toolbarState;
  return (
    a.activeTool === b.activeTool &&
    a.actionConfirmation?.action === b.actionConfirmation?.action &&
    a.actionConfirmation?.sequence === b.actionConfirmation?.sequence &&
    a.canPaste === b.canPaste &&
    a.canRedo === b.canRedo &&
    a.canUndo === b.canUndo &&
    a.fingerDrawingAvailable === b.fingerDrawingAvailable &&
    a.fingerDrawingEnabled === b.fingerDrawingEnabled &&
    a.hasSelection === b.hasSelection &&
    a.openFlyout === b.openFlyout &&
    a.saveStatus === b.saveStatus &&
    a.pasteVisible === b.pasteVisible
  );
}

function sameStyleIcon(left: InkbookEditorChromeProps, right: InkbookEditorChromeProps): boolean {
  const a = left.styleIcon;
  const b = right.styleIcon;
  return (
    sameColor(a.fillColor, b.fillColor) &&
    a.fillOpacity === b.fillOpacity &&
    sameColor(a.outlineColor, b.outlineColor) &&
    a.outlineStyle === b.outlineStyle
  );
}

function sameColor(left: ColorV1 | null, right: ColorV1 | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.type === right.type &&
      (left.type !== "rgba" || (right.type === "rgba" && left.value === right.value)))
  );
}
