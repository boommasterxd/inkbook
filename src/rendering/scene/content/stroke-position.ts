import { sameStrokeLocalPivot } from "../../../domain/geometry/stroke-position";
import type { InkElementV1, StrokeElementV1 } from "../../../domain/schema/public";
import { isStoredStroke } from "../../../domain/elements/stroke-replacement-proof";
import type { PreparedPressureGeometryPort } from "../../../domain/geometry/pressure/prepared-pressure-geometry";
import type { SvgPathPart } from "../../../domain/geometry/element-path";

export function readCanonicalStrokePath(
  element: InkElementV1,
  entry:
    | {
        readonly displayedElement: InkElementV1;
        readonly displayedPathParts: readonly SvgPathPart[];
      }
    | undefined,
): readonly SvgPathPart[] | undefined {
  return element.kind === "stroke" &&
    (Object.isFrozen(element.points) || isStoredStroke(element)) &&
    entry !== undefined &&
    sameStrokeShape(entry.displayedElement, element)
    ? entry.displayedPathParts
    : undefined;
}

/** Scene paths remain in stroke shape space; previews operate on their positioned result. */
export function positionedTransform(
  element: InkElementV1 | undefined,
  preview: string | null,
): string | null {
  if (element?.kind === "text" && element.rotation !== 0) {
    const rotation = `rotate(${element.rotation} ${element.pivot.x} ${element.pivot.y})`;
    return preview === null ? rotation : `${preview} ${rotation}`;
  }
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

export function immutableLocalShape(element: StrokeElementV1): boolean {
  return (
    isStoredStroke(element) ||
    (Object.isFrozen(element) &&
      Object.isFrozen(element.points) &&
      Object.isFrozen(element.style) &&
      Object.isFrozen(element.pivot) &&
      (element.offset === undefined || Object.isFrozen(element.offset)))
  );
}
