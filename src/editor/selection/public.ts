export type { SelectionAreaCandidate, SelectionQueryStep } from "./selection-model";
export { selectBySelectionAreaCandidatesSteps, selectElement } from "./selection-model";
export { createRectangleSelectionArea } from "./query/selection-area";
export type { SelectionArea } from "./query/selection-area";
export { LassoSelectionSession } from "./query/lasso-selection-session";
export { ConnectedSelectionPreviewSession } from "./connection-preview";
export type { ConnectedSelectionPreview } from "./connection-preview";
export { elementContainsPoint, HitTestScratch } from "./query/hit-test";
export { moveSelectionWithSnap, resolveSelectionMoveSnap } from "./transform/move-snap";
export type { SelectionMoveSnap } from "./transform/move-snap";
export { moveSelectionTimeSliced } from "./transform/transforms";
export {
  findSelectionHandle,
  oppositeBoxAnchor,
  oppositeElementHandlePoint,
  selectionBounds,
} from "./handles";
export type { SelectionHandle } from "./handles";
export { selectionOverlayContainsPoint, selectionOverlayGeometry } from "./overlay-geometry";
export type { SelectionOutline, SelectionOverlayGeometry } from "./overlay-geometry";
export {
  createSelectionFrameAtRotation,
  selectionFramePoint,
  SelectionFrameSession,
} from "./selection-frame";
export type { OrientedSelectionFrame, SelectionFrameHistoryEffect } from "./selection-frame";
export { SelectionHandleSession } from "./handle-session";
export { resolvePointAngleSnap } from "./transform/angular-snap";
export type {
  SelectedElementGeometry,
  SelectionHandleAction,
  SelectionHandlePreview,
  SelectionPreviewTransform,
  SelectionSnapFeatures,
  SelectionSnapGuide,
} from "./handle-types";
