import {
  createClosedShapeGeometry,
  createCoordinateSystemGeometry,
  createLinearGeometry,
  createTableGeometry,
  canonicalPoint,
} from "../../domain/geometry/public";
import type {
  BoxShapeElementV1,
  EndpointConnectionV1,
  InkElementV1,
  PointV1,
  StrokeElementV1,
} from "../../domain/schema/public";
import {
  canonicalizeGeometryNumber,
  canonicalizeUnitIntervalNumber,
  MAX_ABSOLUTE_COORDINATE,
  MAX_STROKE_POINTS,
  validateInkElementV1,
} from "../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../domain/settings/types";

interface ElementIdentity {
  readonly id: string;
  readonly createdAt: number;
}

type FreehandTool = "draw" | "highlighter";
type DragCreationTool =
  | "straight-highlighter"
  | "line"
  | "arrow"
  | BoxShapeElementV1["kind"]
  | "coordinate-system"
  | "table";

export interface FreehandCreation {
  readonly identity: ElementIdentity;
  readonly tool: FreehandTool;
  readonly samples: number[];
  readonly defaults: ToolDefaultsV1;
}

export interface DragCreation {
  readonly identity: ElementIdentity;
  readonly tool: DragCreationTool;
  readonly start: PointV1;
  readonly end: PointV1;
  readonly defaults: ToolDefaultsV1;
  readonly startConnection?: EndpointConnectionV1 | null;
  readonly endConnection?: EndpointConnectionV1 | null;
}

export function createFreehandElement(creation: FreehandCreation): StrokeElementV1 {
  const points = canonicalStrokeSamples(creation.samples);
  const styleDefaults =
    creation.tool === "draw" ? creation.defaults.pen : creation.defaults.highlighter;
  const element: StrokeElementV1 = {
    ...creation.identity,
    kind: "stroke",
    tool: creation.tool === "draw" ? "pen" : "highlighter",
    points,
    rotation: 0,
    pivot: strokePivot(points),
    style: {
      color: structuredClone(styleDefaults.color),
      width: styleDefaults.width,
      opacity: styleDefaults.opacity,
      pressureEnabled: creation.tool === "draw" ? creation.defaults.pen.pressureEnabled : false,
      smoothing: 0.5,
    },
  };
  return validatedElement(element) as StrokeElementV1;
}

export function createDragElement(creation: DragCreation): InkElementV1 {
  const { identity, tool, start, end, defaults } = creation;
  if (tool === "coordinate-system") {
    const geometry = createCoordinateSystemGeometry(
      start,
      end,
      defaults.coordinateSystem.dimension,
    );
    return validatedElement({
      ...identity,
      kind: tool,
      rotation: 0,
      ...geometry,
      style: structuredClone(defaults.shapes[tool]),
    } as InkElementV1);
  }
  if (tool === "table") {
    return validatedElement({
      ...identity,
      kind: tool,
      rotation: 0,
      ...createTableGeometry(start, end, defaults.table.columns),
      style: structuredClone(defaults.shapes[tool]),
    });
  }
  if (isClosedShape(tool)) {
    return validatedElement({
      ...identity,
      kind: tool,
      rotation: 0,
      ...createClosedShapeGeometry(start, end),
      style: structuredClone(defaults.shapes[tool]),
    });
  }

  const geometry = createLinearGeometry(start, end);
  if (tool === "straight-highlighter") {
    const style = defaults.straightHighlighter;
    return validatedElement({
      ...identity,
      kind: tool,
      rotation: 0,
      ...geometry,
      startNode: "none",
      endNode: "none",
      style: {
        color: structuredClone(style.color),
        width: style.width,
        opacity: style.opacity,
        pressureEnabled: false,
        smoothing: 0.5,
      },
    });
  }

  const connections = {
    startConnection: creation.startConnection ?? null,
    endConnection: creation.endConnection ?? null,
  };
  if (tool === "line") {
    return validatedElement({
      ...identity,
      kind: tool,
      rotation: 0,
      ...geometry,
      ...connections,
      startNode: "none",
      endNode: "none",
      style: structuredClone(defaults.shapes.line),
    });
  }
  return validatedElement({
    ...identity,
    kind: tool,
    rotation: 0,
    ...geometry,
    ...connections,
    startNode: defaults.arrow.startNode,
    endNode: defaults.arrow.endNode,
    style: structuredClone(defaults.shapes.arrow),
  });
}

function canonicalStrokeSamples(samples: number[]): number[] {
  if (samples.length === 0 || samples.length % 3 !== 0 || samples.length / 3 > MAX_STROKE_POINTS) {
    throw new RangeError("Stroke samples must contain complete x, y, pressure triples.");
  }
  for (let index = 0; index < samples.length; index += 3) {
    const x = canonicalizeGeometryNumber(samples[index] as number);
    const y = canonicalizeGeometryNumber(samples[index + 1] as number);
    const pressure = canonicalizeUnitIntervalNumber(samples[index + 2] as number);
    if (Math.abs(x) > MAX_ABSOLUTE_COORDINATE || Math.abs(y) > MAX_ABSOLUTE_COORDINATE) {
      throw new RangeError("Stroke coordinates exceed the numeric limit.");
    }
    if (pressure < 0 || pressure > 1) {
      throw new RangeError("Stroke pressure must be from 0 through 1.");
    }
    samples[index] = x;
    samples[index + 1] = y;
    samples[index + 2] = pressure;
  }
  return samples;
}

function strokePivot(samples: readonly number[]): PointV1 {
  let minX = samples[0] as number;
  let maxX = minX;
  let minY = samples[1] as number;
  let maxY = minY;
  for (let index = 3; index < samples.length; index += 3) {
    const x = samples[index] as number;
    const y = samples[index + 1] as number;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return canonicalPoint({
    x: canonicalBoundsMidpoint(minX, maxX),
    y: canonicalBoundsMidpoint(minY, maxY),
  });
}

function canonicalBoundsMidpoint(minimum: number, maximum: number): number {
  const summedThousandths = Math.round(minimum * 1000) + Math.round(maximum * 1000);
  const roundedSum =
    Math.abs(summedThousandths) % 2 === 0
      ? summedThousandths
      : summedThousandths + Math.sign(summedThousandths);
  return roundedSum / 2000;
}

function isClosedShape(tool: DragCreationTool): tool is BoxShapeElementV1["kind"] {
  return (
    tool === "rectangle" ||
    tool === "ellipse" ||
    tool === "triangle" ||
    tool === "octagon" ||
    tool === "parallelogram" ||
    tool === "diamond"
  );
}

function validatedElement(element: InkElementV1): InkElementV1 {
  const result = validateInkElementV1(element);
  if (!result.ok) throw new RangeError(`${result.error.path}: ${result.error.message}`);
  return result.value;
}
