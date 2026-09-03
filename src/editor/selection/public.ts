export { selectBySelectionAreaQuery, selectElement } from "./selection-model";
export { createRectangleSelectionArea } from "./selection-area";
export type { SelectionArea } from "./selection-area";
export { LassoSelectionSession } from "./lasso-selection-session";
export { ConnectedSelectionPreviewSession } from "./connection-preview";
export type { ConnectedSelectionPreview } from "./connection-preview";
export { HitTestScratch } from "./hit-test";
export { moveSelectionWithSnap, resolveSelectionMoveSnap } from "./move-snap";
export type { SelectionMoveSnap } from "./move-snap";
export { moveSelectionTimeSliced } from "./transforms";
export {
  findSelectionHandle,
  layoutSelectionHandles,
  oppositeBoxAnchor,
  oppositeElementHandlePoint,
  selectionBounds,
} from "./handles";
export type { SelectionHandle } from "./handles";
export {
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
  transformSelectionPoint,
} from "./overlay-geometry";
export type { SelectionOutline } from "./overlay-geometry";
export {
  createSelectionFrameAtRotation,
  selectionFramePoint,
  SelectionFrameSession,
} from "./selection-frame";
export type { OrientedSelectionFrame, SelectionFrameHistoryEffect } from "./selection-frame";
export { SelectionHandleSession } from "./handle-session";
export { resolvePointAngleSnap } from "./angular-snap";
export type {
  SelectedElementGeometry,
  SelectionHandleAction,
  SelectionHandlePreview,
  SelectionPreviewTransform,
  SelectionSnapFeatures,
  SelectionSnapGuide,
} from "./handle-types";
