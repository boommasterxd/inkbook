export type { SpatialBounds } from "./bounds";
export { measureSpatialCapacity, spatialCellMembershipCount } from "./capacity-measurement";
export { assertMeasuredSpatialCapacity, type SpatialCapacityMeasurement } from "./capacity";
export { SpatialQueryScratch } from "./query-scratch";
export {
  MAX_ELEMENT_CELLS,
  MAX_EXTENT_REBUILD_SLICE,
  MAX_OVERFLOW_ELEMENTS,
  MAX_SPATIAL_MEMBERSHIPS,
  MAX_STALE_EXTENT_POPS,
  SPATIAL_CELL_SIZE,
  UniformSpatialIndex,
} from "./uniform-spatial-index";
export type { PreparedSpatialReplacements } from "./uniform-spatial-index";
