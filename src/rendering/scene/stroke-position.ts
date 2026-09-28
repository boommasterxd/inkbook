import { roundCanonical } from "../../domain/geometry/primitives";
import type { InkElementV1 } from "../../domain/schema/public";
import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";

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

/** Store pressure windows are world-space; never exchange them with translated local paths. */
export function localPressureGeometry(
  element: InkElementV1,
  geometry: PreparedPressureGeometryPort | undefined,
): PreparedPressureGeometryPort | undefined {
  const offset = element.kind === "stroke" ? element.offset : undefined;
  return offset === undefined || (offset.x === 0 && offset.y === 0) ? geometry : undefined;
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
    roundCanonical(a.pivot.x - (a.offset?.x ?? 0)) ===
      roundCanonical(b.pivot.x - (b.offset?.x ?? 0)) &&
    roundCanonical(a.pivot.y - (a.offset?.y ?? 0)) ===
      roundCanonical(b.pivot.y - (b.offset?.y ?? 0))
  );
}
