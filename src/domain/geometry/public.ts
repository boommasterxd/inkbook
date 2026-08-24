export {
  isAnchorTarget,
  resolveShapeAnchor,
  semanticAnchorOrder,
  semanticAnchors,
} from "./anchors";
export { boundsIntersect, calculateElementBounds, effectiveStrokeWidth } from "./bounds";
export { centeredGuideAxis } from "./background-guides";
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
export { deriveLegacyLockedHeight, derivePageExtent } from "./page-extent";
export { translateElementGeometry } from "./translation";
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
