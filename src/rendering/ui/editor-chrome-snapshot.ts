import type { ColorV1 } from "../../domain/schema/public";
import type { InkbookEditorChromeProps } from "./editor-chrome-types";
import type { ToolbarStyleIconState } from "./style-icon";

export function sameEditorChromeProps(
  left: InkbookEditorChromeProps,
  right: InkbookEditorChromeProps,
): boolean {
  return (
    left.localization === right.localization &&
    sameOnboarding(left.onboarding, right.onboarding) &&
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

function sameOnboarding(
  left: InkbookEditorChromeProps["onboarding"],
  right: InkbookEditorChromeProps["onboarding"],
): boolean {
  return (
    left?.container === right?.container &&
    left?.onStart === right?.onStart &&
    left?.onDismiss === right?.onDismiss
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
    state.onboardingContextPreview === true ? "tour-context" : "no-tour-context",
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
    (a.onboardingContextPreview ?? false) === (b.onboardingContextPreview ?? false) &&
    a.openFlyout === b.openFlyout &&
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
    a.outlineStyle === b.outlineStyle &&
    sameTextIcon(a.text, b.text)
  );
}

function sameTextIcon(
  left: ToolbarStyleIconState["text"],
  right: ToolbarStyleIconState["text"],
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.bold === right.bold &&
      left.italic === right.italic &&
      left.strikethrough === right.strikethrough &&
      left.underline === right.underline)
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
