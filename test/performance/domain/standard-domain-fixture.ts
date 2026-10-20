import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import type {
  ArrowElementV1,
  ArrowNodeV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  InkElementV1,
  LinearElementV1,
  StrokeElementV1,
  TableElementV1,
} from "../../../src/domain/schema/public";

const STROKE_COUNT = 10_000;
const STROKE_POINT_COUNT = 500_000;
const SHAPE_COUNT = 500;
const LINE_COUNT = 500;
const ARROW_NODES: readonly ArrowNodeV1[] = ["none", "arrow", "triangle", "diamond", "circle"];

const FIXED_STROKE_STYLE = Object.freeze({
  color: { type: "rgba", value: "#2255AAFF" } as const,
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5 as const,
  width: 8 as const,
});

const THEME_STROKE_STYLE = Object.freeze({
  ...FIXED_STROKE_STYLE,
  color: { type: "theme-text" } as const,
});

const OUTLINE_STYLE = Object.freeze({
  outlineColor: { type: "rgba", value: "#113355FF" } as const,
  outlineOpacity: 1,
  outlineStyle: "solid" as const,
  outlineWidth: 4 as const,
});

const SHAPE_STYLE = Object.freeze({
  ...OUTLINE_STYLE,
  fillColor: null,
  fillOpacity: 0,
});

export interface StandardDomainFixture {
  readonly arrowCount: number;
  readonly arrowNodes: readonly ArrowNodeV1[];
  readonly connectedTargetId: string;
  readonly elements: readonly InkElementV1[];
  readonly lineCount: number;
  readonly linearElementCount: number;
  readonly shapeCount: number;
  readonly strokeCount: number;
  readonly strokePointCount: number;
  readonly strokeIds: readonly string[];
}

export function createStandardDomainFixture(): StandardDomainFixture {
  return createStandardFixture(false);
}

export function createStandardRuntimeDomainFixture(): StandardDomainFixture {
  return createStandardFixture(true);
}

export function createStandardShapeElements(count: number): InkElementV1[] {
  let identity = STROKE_COUNT + 1;
  return createShapes(() => uuid(identity++), count);
}

function createStandardFixture(runtimeStrokeBuffers: boolean): StandardDomainFixture {
  let identity = 1;
  const nextId = (): string => uuid(identity++);
  const pointCounts = createPointCounts();
  const strokes = pointCounts.map((count, index) =>
    createStroke(nextId(), index, count, runtimeStrokeBuffers),
  );
  const shapes = createShapes(nextId);
  const connectedTarget = shapes[0];
  if (connectedTarget?.kind !== "rectangle") throw new Error("Fixture target is missing.");
  const linearElements = createLinearElements(nextId, shapes, connectedTarget);

  return {
    arrowCount: linearElements.filter(({ kind }) => kind === "arrow").length,
    arrowNodes: linearElements.flatMap((element) =>
      element.kind === "arrow" ? [element.startNode, element.endNode] : [],
    ),
    connectedTargetId: connectedTarget.id,
    elements: [...strokes, ...shapes, ...linearElements],
    lineCount: linearElements.filter(({ kind }) => kind === "line").length,
    linearElementCount: linearElements.length,
    shapeCount: shapes.length,
    strokeCount: strokes.length,
    strokePointCount: pointCounts.reduce((total, count) => total + count, 0),
    strokeIds: strokes.map(({ id }) => id),
  };
}

export function createMaximumStroke(id = uuid(90_000)): StrokeElementV1 {
  return createStroke(id, 1, MAX_STROKE_POINTS, false);
}

export function createDenseSnapTargets(count = 128): readonly BoxShapeElementV1[] {
  if (!Number.isInteger(count) || count < 1 || count > 512) {
    throw new RangeError("Dense snap fixtures contain 1 through 512 targets.");
  }
  return Array.from({ length: count }, (_, index) =>
    createRectangle(uuid(100_000 + index), 100, 500, 100),
  );
}

function createPointCounts(): number[] {
  const counts = new Array<number>(STROKE_COUNT).fill(50);
  counts[0] = 1;
  counts[1] = 500;
  for (let index = 2; index < 10; index += 1) counts[index] = 1;
  counts[10] = 41;
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total !== STROKE_POINT_COUNT) throw new Error("Stroke point fixture is inconsistent.");
  return counts;
}

function createStroke(
  id: string,
  index: number,
  pointCount: number,
  runtimeStrokeBuffer: boolean,
): StrokeElementV1 {
  const baseX = 30 + (index % 50) * 39;
  const baseY = 30 + Math.floor(index / 50) * 1006;
  const wirePoints = createStrokePoints(baseX, baseY, pointCount, index === 1);
  const points = runtimeStrokeBuffer ? new Float64Array(wirePoints) : wirePoints;
  const lastX = points[points.length - 3] as number;
  const lastY = points[points.length - 2] as number;
  return {
    createdAt: index,
    id,
    kind: "stroke",
    pivot: { x: (baseX + lastX) / 2, y: (baseY + lastY) / 2 },
    points: points as unknown as StrokeElementV1["points"],
    rotation: 0,
    style: index % 2 === 0 ? THEME_STROKE_STYLE : FIXED_STROKE_STYLE,
    tool: "pen",
  };
}

function createStrokePoints(
  baseX: number,
  baseY: number,
  pointCount: number,
  overflow: boolean,
): number[] {
  const points = new Array<number>(pointCount * 3);
  for (let point = 0; point < pointCount; point += 1) {
    const offset = point * 3;
    points[offset] = baseX + (point % 32) * 0.25;
    points[offset + 1] = overflow
      ? baseY + point * Math.min(150, 900_000 / (pointCount - 1))
      : baseY + Math.floor(point / 32) * 0.25;
    points[offset + 2] = (point % 101) / 100;
  }
  return points;
}

function createShapes(nextId: () => string, count = SHAPE_COUNT): InkElementV1[] {
  const shapes: InkElementV1[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = 100 + (index % 10) * 170;
    const y = 500 + Math.floor(index / 10) * 2500;
    if (index === 100) shapes.push(createCoordinateSystem(nextId(), x, y));
    else if (index === 200) shapes.push(createTable(nextId(), x, y));
    else shapes.push(createRectangle(nextId(), x, y, index === 1 ? 70_000 : 100));
  }
  return shapes;
}

function createRectangle(id: string, x: number, y: number, height: number): BoxShapeElementV1 {
  return {
    createdAt: 20_000,
    height,
    id,
    kind: "rectangle",
    pivot: { x: x + 60, y: y + height / 2 },
    rotation: 0,
    style: SHAPE_STYLE,
    width: 120,
    x,
    y,
  };
}

function createCoordinateSystem(id: string, x: number, y: number): CoordinateSystemElementV1 {
  return {
    axes: [
      { x: x + 100, y },
      { x, y: y - 100 },
    ],
    createdAt: 20_000,
    dimension: "2d",
    id,
    kind: "coordinate-system",
    origin: { x, y },
    pivot: { x, y },
    rotation: 0,
    style: OUTLINE_STYLE,
  };
}

function createTable(id: string, x: number, y: number): TableElementV1 {
  return {
    columnWidth: 50,
    columns: 3,
    createdAt: 20_000,
    headerHeight: 30,
    height: 100,
    id,
    kind: "table",
    pivot: { x: x + 75, y: y + 50 },
    rotation: 0,
    style: OUTLINE_STYLE,
    x,
    y,
  };
}

function createLinearElements(
  nextId: () => string,
  shapes: readonly InkElementV1[],
  connectedTarget: BoxShapeElementV1,
): LinearElementV1[] {
  const linearElements: LinearElementV1[] = [];
  for (let index = 0; index < LINE_COUNT; index += 1) {
    const target = index < 256 ? connectedTarget : eligibleRectangle(shapes, index);
    const start = { x: target.x, y: target.y };
    const end =
      index < 256
        ? { x: target.x + target.width, y: target.y + target.height }
        : { x: target.x + target.width + 80, y: target.y + target.height };
    const shared: Omit<ArrowElementV1, "endNode" | "kind" | "startNode"> = {
      bend: null,
      createdAt: 30_000 + index,
      end,
      endConnection:
        index < 256
          ? {
              anchor: { kind: "box", position: "bottom-right" },
              targetId: target.id,
            }
          : null,
      id: nextId(),
      pivot: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
      rotation: 0,
      start,
      startConnection: {
        anchor: { kind: "box", position: "top-left" },
        targetId: target.id,
      },
      style: OUTLINE_STYLE,
    };
    linearElements.push(
      index % 2 === 0
        ? { ...shared, endNode: "none", kind: "line", startNode: "none" }
        : createArrow(shared, index),
    );
  }
  return linearElements;
}

function createArrow(
  shared: Omit<ArrowElementV1, "endNode" | "kind" | "startNode">,
  index: number,
): ArrowElementV1 {
  const arrowIndex = Math.floor(index / 2);
  return {
    ...shared,
    endNode: ARROW_NODES[(arrowIndex + 2) % ARROW_NODES.length]!,
    kind: "arrow",
    startNode: ARROW_NODES[arrowIndex % ARROW_NODES.length]!,
  };
}

function eligibleRectangle(shapes: readonly InkElementV1[], index: number): BoxShapeElementV1 {
  const candidate = shapes[2 + (index % (shapes.length - 2))];
  if (candidate?.kind === "rectangle") return candidate;
  return eligibleRectangle(shapes, index + 1);
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
