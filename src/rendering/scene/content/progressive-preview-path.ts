import { CanonicalElementPathPreparation } from "../../../domain/geometry/canonical-element-path-preparation";
import type { PreparedPressureGeometryPort } from "../../../domain/geometry/pressure/prepared-pressure-geometry";
import type { InkElementV1 } from "../../../domain/schema/public";
import { localPressureGeometry } from "./stroke-position";

/** Scene adapter for the shared canonical contour preparation. */
export class ProgressivePreviewPath extends CanonicalElementPathPreparation {
  public constructor(element: InkElementV1, geometry?: PreparedPressureGeometryPort) {
    const local = localPressureGeometry(element, geometry);
    super(element, local, local === undefined ? "path-only" : "full");
  }
}
