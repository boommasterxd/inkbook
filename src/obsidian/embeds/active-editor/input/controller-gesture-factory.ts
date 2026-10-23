import { GestureController, type GestureControllerPorts } from "../../../../editor/gestures/public";

type GestureContext = readonly [
  openContextMenu: GestureControllerPorts["openContextMenu"],
  beginPreview: GestureControllerPorts["beginPreview"],
];

type GestureNavigation = readonly [
  beginPinch: GestureControllerPorts["beginPinch"],
  finishPinch: GestureControllerPorts["finishPinch"],
  panPage: GestureControllerPorts["panPage"],
  revertNavigation: GestureControllerPorts["revertNavigation"],
  revertPinch: GestureControllerPorts["revertPinch"],
  updatePinch: GestureControllerPorts["updatePinch"],
];

type GesturePointer = readonly [
  cancelLongPress: GestureControllerPorts["cancelLongPress"],
  capturePointer: GestureControllerPorts["capturePointer"],
  releasePointer: GestureControllerPorts["releasePointer"],
  scheduleLongPress: GestureControllerPorts["scheduleLongPress"],
];

type GestureSelection = readonly [
  clearSelection: GestureControllerPorts["clearSelection"],
  selectElement: GestureControllerPorts["selectElement"],
];

type GestureTools = readonly [
  activateTemporaryEraser: GestureControllerPorts["activateTemporaryEraser"],
  restoreTemporaryTool: GestureControllerPorts["restoreTemporaryTool"],
];

export function createActiveEditorGestureController(
  [openContextMenu, beginPreview]: GestureContext,
  [beginPinch, finishPinch, panPage, revertNavigation, revertPinch, updatePinch]: GestureNavigation,
  [cancelLongPress, capturePointer, releasePointer, scheduleLongPress]: GesturePointer,
  [clearSelection, selectElement]: GestureSelection,
  [activateTemporaryEraser, restoreTemporaryTool]: GestureTools,
): GestureController {
  return new GestureController({
    activateTemporaryEraser,
    beginPinch,
    beginPreview,
    cancelLongPress,
    capturePointer,
    clearSelection,
    finishPinch,
    openContextMenu,
    panPage,
    releasePointer,
    restoreTemporaryTool,
    revertNavigation,
    revertPinch,
    scheduleLongPress,
    scrollNote: () => undefined,
    selectElement,
    updatePinch,
  });
}
