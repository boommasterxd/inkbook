import type { InkElementV1 } from "../schema/types";
import { measureSpatialCapacity, type SpatialCapacityMeasurement } from "../spatial/index";

import { calculateElementBounds } from "./bounds";

export function measureElementSpatialCapacity(
  elements: Iterable<InkElementV1>,
): SpatialCapacityMeasurement {
  return measureSpatialCapacity(boundsOf(elements));
}

function* boundsOf(elements: Iterable<InkElementV1>) {
  for (const element of elements) yield calculateElementBounds(element);
}
