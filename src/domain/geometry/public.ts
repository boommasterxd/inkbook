export { isAnchorTarget, resolveShapeAnchor } from "./anchors";
export {
  boundsIntersect,
  calculateElementBounds,
  calculateElementBoundsSteps,
  effectiveStrokeWidth,
} from "./bounds";
export { backgroundGuideLayout } from "./background-guides";
export {
  changeCoordinateSystemDimension,
  changeTableColumns,
  createClosedShapeGeometry,
  createCoordinateSystemGeometry,
  createLinearGeometry,
  createTableGeometry,
  defaultTableHeaderHeight,
  tableColumnOffsets,
  tableWidth,
} from "./creation";
export { buildElementPathParts, outlineDashPattern } from "./element-path";
export { alignPageHeightToWritingLine, derivePageExtent } from "./page-extent";
export { translateElementGeometry } from "./translation";
export {
  PAGE_WIDTH,
  assertFinitePoint,
  boundsFromPoints,
  canonicalPoint,
  linearPivot,
  normalizeRotation,
  pointDistance,
  pointInPolygon,
  pointSegmentDistance,
  quadraticPoint,
  rotatePointClockwise,
  roundCanonical,
  segmentDistanceSquared,
  segmentsIntersect,
  unionBounds,
  type Bounds,
} from "./primitives";
export {
  type RawStrokeSample,
  type StrokeInputOptions,
  type StrokePathGeometry,
} from "./stroke-path";
