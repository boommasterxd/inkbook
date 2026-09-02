export {
  isAnchorTarget,
  resolveShapeAnchor,
  semanticAnchorOrder,
  semanticAnchors,
} from "./anchors";
export { boundsIntersect, calculateElementBounds, effectiveStrokeWidth } from "./bounds";
export {
  backgroundGuideLayout,
  centeredGuideAxis,
  topAnchoredGuideAxis,
  type BackgroundGuideLayoutRequest,
} from "./background-guides";
export {
  changeCoordinateSystemDimension,
  changeTableColumns,
  createClosedShapeGeometry,
  createCoordinateSystemGeometry,
  createLinearGeometry,
  createTableGeometry,
  defaultTableHeaderHeight,
  shapeVertices,
  tableColumnOffsets,
  tableLineSegments,
  tableWidth,
} from "./creation";
export {
  arrowNodeGeometry,
  buildClosedShapePath,
  buildCoordinateSystemPath,
  buildElementPathParts,
  buildLinearPathParts,
  buildTablePath,
  linearEndpointDirections,
  nodeSize,
  outlineDashPattern,
} from "./element-path";
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
  quadraticBounds,
  quadraticPoint,
  rotatePointClockwise,
  roundCanonical,
  segmentDistanceSquared,
  segmentsIntersect,
  unionBounds,
  type Bounds,
} from "./primitives";
export {
  buildCenterline,
  buildPressureOutline,
  buildPressureOutlinePairs,
  buildStrokePath,
  prepareStrokeSamples,
  smoothStrokeCenters,
  type RawStrokeSample,
  type StrokeInputOptions,
  type StrokePathGeometry,
} from "./stroke-path";
export { measureElementSpatialCapacity } from "./spatial-capacity";
