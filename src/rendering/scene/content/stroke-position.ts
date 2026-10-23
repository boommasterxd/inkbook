import { sameStrokeLocalPivot } from "../../../domain/geometry/stroke-position";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { PreparedPressureGeometryPort } from "../../../domain/geometry/pressure/prepared-pressure-geometry";

/** Scene paths remain in stroke shape space; previews operate on their positioned result. */
export function positionedTransform(
  element: InkElementV1 | undefined,
  preview: string | null,
): string | null {
  const offset = element?.kind === "stroke" ? element.offset : undefined;
  if (offset === undefined || (offset.x === 0 && offset.y === 0)) return preview;
  const position = `translate(${offset.x} ${offset.y})`;
  return preview === null ? position : `${preview} ${position}`;
}

/** Translated paths exchange windows only through the explicit shape-local preparation port. */
export function localPressureGeometry(
  element: InkElementV1,
  geometry: PreparedPressureGeometryPort | undefined,
): PreparedPressureGeometryPort | undefined {
  const offset = element.kind === "stroke" ? element.offset : undefined;
  return offset === undefined || (offset.x === 0 && offset.y === 0)
    ? geometry
    : geometry?.local?.();
}

/** A mounted path remains valid when only its durable position or paint changes. */
export function sameStrokeShape(a: InkElementV1, b: InkElementV1): boolean {
  return (
    a.kind === "stroke" &&
    b.kind === "stroke" &&
    a.points === b.points &&
    a.rotation === b.rotation &&
    a.tool === b.tool &&
    a.style.width === b.style.width &&
    a.style.smoothing === b.style.smoothing &&
    a.style.pressureEnabled === b.style.pressureEnabled &&
    sameStrokeLocalPivot(a, b)
  );
}
