import { assertSpatialBounds } from "../spatial/bounds";
import {
  MAX_ELEMENT_CELLS,
  spatialCellMembershipCount,
  type SpatialBounds,
} from "../spatial/index";
import type { InkElementV1 } from "./types";
import type { ElementValidationDerivation } from "./validation-types";

export function validatedElementDerivationBounds(
  element: InkElementV1,
  derivation: ElementValidationDerivation,
): Readonly<SpatialBounds> {
  if (derivation.elementId !== element.id) {
    throw new TypeError("Element derivation does not match its element ID.");
  }
  assertSpatialBounds(derivation.bounds);
  const memberships = spatialCellMembershipCount(derivation.bounds);
  const overflow = memberships > MAX_ELEMENT_CELLS;
  if (
    derivation.spatialOverflow !== overflow ||
    derivation.spatialMemberships !== (overflow ? 0 : memberships)
  ) {
    throw new TypeError("Element derivation has inconsistent spatial capacity.");
  }
  return derivation.bounds;
}
