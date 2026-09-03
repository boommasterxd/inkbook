export type { SpatialBounds } from "./bounds";
export { measureSpatialCapacity, spatialCellMembershipCount } from "./capacity-measurement";
export { SpatialQueryScratch } from "./query-scratch";
export {
  MAX_ELEMENT_CELLS,
  MAX_OVERFLOW_ELEMENTS,
  MAX_SPATIAL_MEMBERSHIPS,
  SPATIAL_CELL_SIZE,
  UniformSpatialIndex,
} from "./uniform-spatial-index";
export type { PreparedSpatialReplacements } from "./uniform-spatial-index";
