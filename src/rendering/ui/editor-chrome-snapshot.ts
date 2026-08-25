import type { ColorV1 } from "../../domain/schema/public";
import type { InkbookEditorChromeProps } from "./editor-chrome-types";
import type { StyleControl } from "./flyout-types";

export function sameEditorChromeProps(
  left: InkbookEditorChromeProps,
  right: InkbookEditorChromeProps,
): boolean {
  return (
    sameChromeReferences(left, right) &&
    left.layout === right.layout &&
    (left.leftHanded ?? false) === (right.leftHanded ?? false) &&
    left.selectedShape === right.selectedShape &&
    left.background.type === right.background.type &&
    left.background.spacing === right.background.spacing &&
    sameToolbarState(left, right) &&
    sameOverflowMenu(left, right) &&
    sameStyleIcon(left, right) &&
    sameStyleControls(left.styleControls, right.styleControls)
  );
}

export function editorChromeLayoutKey(props: InkbookEditorChromeProps): string {
  const state = props.toolbarState;
  return [
    props.layout,
    props.leftHanded === true ? "left" : "right",
    state.fingerDrawingAvailable ? "finger" : "no-finger",
    state.hasSelection ? "selection" : "no-selection",
    state.canPaste ? "paste" : "no-paste",
  ].join(":");
}

function sameChromeReferences(
  left: InkbookEditorChromeProps,
  right: InkbookEditorChromeProps,
): boolean {
  return (
    left.callbacks === right.callbacks &&
    left.canvasInput === right.canvasInput &&
    left.onToolbarAction === right.onToolbarAction &&
    left.ownerDocument === right.ownerDocument &&
    left.renderIcon === right.renderIcon
  );
}

function sameToolbarState(
  left: InkbookEditorChromeProps,
  right: InkbookEditorChromeProps,
): boolean {
  const a = left.toolbarState;
  const b = right.toolbarState;
  return (
    a.activeTool === b.activeTool &&
    a.canPaste === b.canPaste &&
    a.canRedo === b.canRedo &&
    a.canUndo === b.canUndo &&
    a.fingerDrawingAvailable === b.fingerDrawingAvailable &&
    a.fingerDrawingEnabled === b.fingerDrawingEnabled &&
    a.hasSelection === b.hasSelection &&
    a.openFlyout === b.openFlyout
  );
}

function sameOverflowMenu(
  left: InkbookEditorChromeProps,
  right: InkbookEditorChromeProps,
): boolean {
  const a = left.overflowMenu;
  const b = right.overflowMenu;
  return (
    a.canEraseAll === b.canEraseAll &&
    a.hasSelection === b.hasSelection &&
    a.arrange["bring-forward"] === b.arrange["bring-forward"] &&
    a.arrange["bring-to-front"] === b.arrange["bring-to-front"] &&
    a.arrange["send-backward"] === b.arrange["send-backward"] &&
    a.arrange["send-to-back"] === b.arrange["send-to-back"]
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

function sameStyleControls(left: readonly StyleControl[], right: readonly StyleControl[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameStyleControl(left[index], right[index])) return false;
  }
  return true;
}

function sameStyleControl(
  left: StyleControl | undefined,
  right: StyleControl | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  if (left.id !== right.id || left.label !== right.label) return false;
  if (left.kind === "toggle" && right.kind === "toggle") return left.checked === right.checked;
  if (left.kind === "number" && right.kind === "number") {
    return (
      left.max === right.max &&
      left.min === right.min &&
      left.mixed === right.mixed &&
      left.step === right.step &&
      left.value === right.value
    );
  }
  return left.kind === "choice" && right.kind === "choice" && sameChoiceControl(left, right);
}

function sameChoiceControl(
  left: Extract<StyleControl, { readonly kind: "choice" }>,
  right: Extract<StyleControl, { readonly kind: "choice" }>,
): boolean {
  if (left.mixed !== right.mixed || left.value !== right.value) return false;
  if (left.options.length !== right.options.length) return false;
  for (let index = 0; index < left.options.length; index += 1) {
    const a = left.options[index];
    const b = right.options[index];
    if (a?.label !== b?.label || a?.value !== b?.value) return false;
  }
  return true;
}

function sameColor(left: ColorV1 | null, right: ColorV1 | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.type === right.type &&
      (left.type === "theme-text" || (right.type === "rgba" && left.value === right.value)))
  );
}
