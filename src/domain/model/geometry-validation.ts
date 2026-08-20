import { decodeDeltaVarintStroke } from "../codecs/delta-varint";
import type { SceneElementV1, SceneElementValueV1 } from "./elements";
import { materializeSceneElementV1 } from "./elements";
import type {
  CanonicalGeometryV1,
  LinearEndpointV1,
  LinearGeometryV1,
  NonLinearGeometryV1,
} from "./geometry";
import {
  materializeAreaGeometryV1,
  materializeAxes2DGeometryV1,
  materializeAxes3DGeometryV1,
  materializeLinearGeometryV1,
  materializeStrokeGeometryV1,
  materializeTableGeometryV1,
} from "./geometry";
import {
  createBindingRevision,
  createGeometryRevision,
  createStyleRevision,
  parseElementId,
} from "./scalars";
import {
  validateCanonicalStyleV1,
  validateElementBindingV1,
} from "./validation";
import type { DataRecord } from "./validation-support";
import {
  canonicalRotation,
  closedRecord,
  closedValue,
  finiteNumber,
  MIN_AREA_EXTENT,
  noteCoordinate,
  NOTE_COORDINATE_LIMIT,
  notePoint,
} from "./validation-support";

const MAX_TABLE_DIVIDERS = 199;
const MAX_GRID_DIVISIONS = 64;
const MIN_TABLE_EXTENT = 2;
const HALF = 2;
const AXES_2D = 2;
const AXES_3D = 3;
const FLOAT_COMPARISON_ULPS = 4;
type ElementKind = SceneElementV1["kind"];
type NonLinearKind = Exclude<ElementKind, "line" | "arrow">;
interface Vector {
  readonly x: number;
  readonly y: number;
}

function area(
  value: unknown,
  minimum: number,
): ReturnType<typeof materializeAreaGeometryV1> {
  const data = closedRecord(
    value,
    ["center", "height", "rotationRadians", "width"],
    "Area geometry",
  );
  data.center = notePoint(data.center, "Area center");
  finiteNumber(data.width, "Area width", minimum, NOTE_COORDINATE_LIMIT);
  finiteNumber(data.height, "Area height", minimum, NOTE_COORDINATE_LIMIT);
  canonicalRotation(data.rotationRadians, "Area rotation");
  return materializeAreaGeometryV1(
    data as unknown as Parameters<typeof materializeAreaGeometryV1>[0],
  );
}

function attachment(value: unknown): unknown {
  if (value === null) return null;
  const data = closedRecord(
    value,
    ["portId", "targetElementId"],
    "Endpoint attachment",
  );
  if (typeof data.targetElementId !== "string") {
    throw new TypeError("Attachment target ID must be a string.");
  }
  parseElementId(data.targetElementId);
  closedValue(
    data.portId,
    [
      "area:north",
      "area:east",
      "area:south",
      "area:west",
      "axes:origin",
      "axes:x-positive",
      "axes:y-positive",
      "axes:z-positive",
    ],
    "Object port",
  );
  return Object.freeze({ ...data });
}

function endpoint(value: unknown): LinearEndpointV1 {
  const data = closedRecord(
    value,
    ["attachment", "fallbackPoint"],
    "Linear endpoint",
  );
  data.fallbackPoint = notePoint(data.fallbackPoint, "Endpoint fallback");
  data.attachment = attachment(data.attachment);
  return Object.freeze({ ...data }) as unknown as LinearEndpointV1;
}

export function validateLinearGeometryV1(value: unknown): LinearGeometryV1 {
  const data = closedRecord(
    value,
    ["control", "end", "start"],
    "Linear geometry",
  );
  data.start = endpoint(data.start);
  data.end = endpoint(data.end);
  data.control =
    data.control === null ? null : notePoint(data.control, "Curve control");
  return materializeLinearGeometryV1(data as unknown as LinearGeometryV1);
}

function dividers(
  value: unknown,
  extent: number,
  name: string,
): readonly number[] {
  if (!Array.isArray(value) || value.length > MAX_TABLE_DIVIDERS) {
    throw new RangeError(`${name} dividers exceed the V1 limit.`);
  }
  const result: number[] = [];
  let previous = -extent / HALF;
  for (const candidate of value) {
    const current = noteCoordinate(candidate, `${name} divider`);
    if (
      current <= previous ||
      current >= extent / HALF ||
      !hasMinimumSeparation(previous, current)
    ) {
      throw new RangeError(`${name} dividers are not canonically separated.`);
    }
    result.push(current);
    previous = current;
  }
  if (!hasMinimumSeparation(previous, extent / HALF)) {
    throw new RangeError(`${name} final track is too small.`);
  }
  return Object.freeze(result);
}

function hasMinimumSeparation(lower: number, upper: number): boolean {
  const magnitude = Math.max(1, Math.abs(lower), Math.abs(upper));
  const tolerance = Number.EPSILON * magnitude * FLOAT_COMPARISON_ULPS;
  return upper - lower >= MIN_AREA_EXTENT - tolerance;
}

function assertAxes(vectors: readonly Vector[], gridDivisions: unknown): void {
  if (
    !Number.isInteger(gridDivisions) ||
    (gridDivisions as number) < 0 ||
    (gridDivisions as number) > MAX_GRID_DIVISIONS
  ) {
    throw new RangeError("Grid divisions are outside the V1 range.");
  }
  if (vectors.some((vector) => vector.x === 0 && vector.y === 0)) {
    throw new RangeError("Axis vectors must be non-zero.");
  }
  for (let left = 0; left < vectors.length; left += 1) {
    const a = vectors[left];
    if (a === undefined) continue;
    for (let right = left + 1; right < vectors.length; right += 1) {
      const b = vectors[right];
      if (b === undefined) continue;
      if (a.x * b.y === a.y * b.x) {
        throw new RangeError("Axis vectors must be pairwise non-collinear.");
      }
    }
  }
}

function axes(
  value: unknown,
  dimensions: typeof AXES_2D | typeof AXES_3D,
): NonLinearGeometryV1 {
  const keys =
    dimensions === AXES_2D
      ? ["gridDivisions", "origin", "xAxis", "yAxis"]
      : ["gridDivisions", "origin", "xAxis", "yAxis", "zAxis"];
  const name = dimensions === AXES_2D ? "2D" : "3D";
  const data = closedRecord(value, keys, `${name} axes geometry`);
  data.origin = notePoint(data.origin, "Axes origin");
  data.xAxis = notePoint(data.xAxis, "X axis");
  data.yAxis = notePoint(data.yAxis, "Y axis");
  if (dimensions === AXES_3D) data.zAxis = notePoint(data.zAxis, "Z axis");
  const vectors = [
    data.xAxis as Vector,
    data.yAxis as Vector,
    ...(dimensions === AXES_3D ? [data.zAxis as Vector] : []),
  ];
  assertAxes(vectors, data.gridDivisions);
  if (dimensions === AXES_2D) {
    return materializeAxes2DGeometryV1(
      data as unknown as Parameters<typeof materializeAxes2DGeometryV1>[0],
    );
  }
  return materializeAxes3DGeometryV1(
    data as unknown as Parameters<typeof materializeAxes3DGeometryV1>[0],
  );
}

function stroke(value: unknown): NonLinearGeometryV1 {
  const data = closedRecord(
    value,
    ["selectionRotationRadians", "stroke"],
    "Stroke geometry",
  );
  canonicalRotation(data.selectionRotationRadians, "Stroke selection rotation");
  const decoded = decodeDeltaVarintStroke(data.stroke);
  for (const sample of decoded.points) {
    noteCoordinate(sample.x, "Stroke X");
    noteCoordinate(sample.y, "Stroke Y");
  }
  return materializeStrokeGeometryV1(
    data as unknown as Parameters<typeof materializeStrokeGeometryV1>[0],
  );
}

function table(value: unknown): NonLinearGeometryV1 {
  const data = closedRecord(
    value,
    [
      "center",
      "columnDividerOffsets",
      "height",
      "rotationRadians",
      "rowDividerOffsets",
      "width",
    ],
    "Table geometry",
  );
  data.center = notePoint(data.center, "Table center");
  finiteNumber(
    data.width,
    "Table width",
    MIN_TABLE_EXTENT,
    NOTE_COORDINATE_LIMIT,
  );
  finiteNumber(
    data.height,
    "Table height",
    MIN_TABLE_EXTENT,
    NOTE_COORDINATE_LIMIT,
  );
  canonicalRotation(data.rotationRadians, "Table rotation");
  data.rowDividerOffsets = dividers(
    data.rowDividerOffsets,
    data.height as number,
    "Row",
  );
  data.columnDividerOffsets = dividers(
    data.columnDividerOffsets,
    data.width as number,
    "Column",
  );
  return materializeTableGeometryV1(
    data as unknown as Parameters<typeof materializeTableGeometryV1>[0],
  );
}

export function validateNonLinearGeometryV1(
  value: unknown,
  kind: NonLinearKind,
): NonLinearGeometryV1 {
  if (kind === "pen" || kind === "highlighter") return stroke(value);
  if (kind === "table") return table(value);
  if (kind === "axes-2d") return axes(value, AXES_2D);
  if (kind === "axes-3d") return axes(value, AXES_3D);
  return area(value, MIN_AREA_EXTENT);
}

function validateElement(
  value: unknown,
  revisions: boolean,
): SceneElementV1 | SceneElementValueV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Scene element must be a data object.");
  }
  const kind = closedValue(
    (value as DataRecord).kind,
    [
      "pen",
      "highlighter",
      "rectangle",
      "ellipse",
      "triangle",
      "diamond",
      "octagon",
      "line",
      "arrow",
      "table",
      "axes-2d",
      "axes-3d",
    ],
    "Element kind",
  );
  const revisionKeys = revisions
    ? ["bindingRevision", "geometryRevision", "styleRevision"]
    : [];
  const data = closedRecord(
    value,
    ["binding", "elementId", "geometry", "kind", "style", ...revisionKeys],
    "Scene element",
  );
  if (typeof data.elementId !== "string") {
    throw new TypeError("Element ID must be a string.");
  }
  parseElementId(data.elementId);
  data.binding = validateElementBindingV1(data.binding);
  data.style = validateCanonicalStyleV1(data.style, kind);
  data.geometry = validateCanonicalGeometryV1(data.geometry, kind);
  validateStrokePressure(data, kind);
  if (!revisions) {
    return Object.freeze({ ...data }) as unknown as SceneElementValueV1;
  }
  data.geometryRevision = createGeometryRevision(
    data.geometryRevision as number,
  );
  data.styleRevision = createStyleRevision(data.styleRevision as number);
  data.bindingRevision = createBindingRevision(data.bindingRevision as number);
  return materializeSceneElementV1(data as unknown as SceneElementV1);
}

function validateStrokePressure(data: DataRecord, kind: ElementKind): void {
  if (kind === "pen") {
    const pressure = (data.style as { pressure: string }).pressure;
    const expected = pressure === "constant" ? "absent" : "present";
    if (
      (data.geometry as { stroke: { pressure: string } }).stroke.pressure !==
      expected
    ) {
      throw new TypeError("Pen pressure mode does not match its stroke.");
    }
  }
  if (
    kind === "highlighter" &&
    (data.geometry as { stroke: { pressure: string } }).stroke.pressure !==
      "absent"
  ) {
    throw new TypeError("Highlighter strokes cannot store pressure.");
  }
}

export function validateSceneElementV1(value: unknown): SceneElementV1 {
  return validateElement(value, true) as SceneElementV1;
}

export function validateSceneElementValueV1(
  value: unknown,
): SceneElementValueV1 {
  return validateElement(value, false);
}

export function validateCanonicalGeometryV1(
  value: unknown,
  kind: ElementKind,
): CanonicalGeometryV1 {
  return kind === "line" || kind === "arrow"
    ? validateLinearGeometryV1(value)
    : validateNonLinearGeometryV1(value, kind);
}
