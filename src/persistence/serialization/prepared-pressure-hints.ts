import type { SvgPathPart } from "../../domain/geometry/element-path";
import type { ElementRecord } from "../../domain/store/types";
import type { InkElementV1, StrokeElementV1 } from "../../domain/schema/public";

export const MAX_PREPARED_PRESSURE_HINT_BYTES = 4 * 1024 * 1024;
export const MAX_PREPARED_PRESSURE_HINTS = 1024;

export interface PreparedPressurePathHint {
  readonly d: string;
  readonly geometryVersion: number;
  readonly id: string;
  readonly modelRevision: number;
  readonly shapeKey: string;
}

/** Only a current Store-owned stroke may lend a scene-generated local path to export. */
export function preparedPressurePathHint(
  record: ElementRecord,
  parts: readonly SvgPathPart[],
  modelRevision: number,
): PreparedPressurePathHint | undefined {
  const source = record?.element;
  if (
    source?.kind !== "stroke" ||
    !source.style.pressureEnabled ||
    (source.offset !== undefined && (source.offset.x !== 0 || source.offset.y !== 0)) ||
    parts.length !== 1 ||
    parts[0]?.paint !== "fill"
  )
    return undefined;
  return {
    d: parts[0].d,
    geometryVersion: record.geometryVersion,
    id: source.id,
    modelRevision,
    shapeKey: pressureShapeKey(source),
  };
}

export function pressureShapeKey(stroke: {
  readonly tool: string;
  readonly rotation: number;
  readonly pivot: { readonly x: number; readonly y: number };
  readonly style: { readonly width: number; readonly smoothing: number };
  readonly points: { readonly length: number };
}): string {
  return [
    stroke.tool,
    stroke.rotation,
    stroke.pivot.x,
    stroke.pivot.y,
    stroke.style.width,
    stroke.style.smoothing,
    stroke.points.length,
  ].join(":");
}

export function preparedPressureHintBytes(hint: PreparedPressurePathHint): number {
  return 72 + (hint.id.length + hint.shapeKey.length + hint.d.length) * 2;
}

export function matchesPreparedPressurePath(
  element: InkElementV1 | undefined,
  shapeKey: string,
): element is StrokeElementV1 {
  return (
    element?.kind === "stroke" &&
    element.style.pressureEnabled &&
    (element.offset === undefined || (element.offset.x === 0 && element.offset.y === 0)) &&
    pressureShapeKey(element) === shapeKey
  );
}
