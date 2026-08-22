export {
  isAnchorTarget,
  resolveShapeAnchor,
  semanticAnchorOrder,
  semanticAnchors,
} from "./anchors";
export {
  boundsCorrection,
  boundsIntersect,
  calculateElementBounds,
  effectiveStrokeWidth,
} from "./bounds";
export {
  changeCoordinateSystemDimension,
  changeTableColumns,
  createClosedShapeGeometry,
  createCoordinateSystemGeometry,
  createLinearGeometry,
  createTableGeometry,
  shapeVertices,
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
export { derivePageExtent } from "./page-extent";
export {
  assertElementsWithinPageBounds,
  canonicalPageBoundsCorrection,
  correctElementsToPageBounds,
  isWithinPageBounds,
  translateElementGeometry,
} from "./page-bounds";
export {
  PAGE_WIDTH,
  canonicalPoint,
  normalizeRotation,
  pointInPolygon,
  pointDistance,
  quadraticBounds,
  quadraticPoint,
  rotatePointClockwise,
  roundCanonical,
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
