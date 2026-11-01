import { FILE_SCHEMA_LIMITS, PAGE_MARGIN } from "../../../domain/schema/constants";
import type { InkElementV1, PointV1 } from "../../../domain/schema/types";
import type { SourceStrokeCurveSegment } from "./source-stroke-curve";
import { sampleSourceStrokeCurveSteps } from "./stroke-geometry";
import {
  tldrawArrowNode,
  tldrawOutlineStyle,
  tldrawShapeStyle,
  tldrawStrokeStyle,
} from "./tldraw-style";
import {
  array,
  finite,
  invalid,
  optionalNumber,
  point,
  record,
  rotation,
  targetId,
  text,
  unit,
  unsupported,
  type SourceRecord,
} from "./source-values";

export interface TldrawElementContext {
  readonly timestamp: number;
  readonly warnings: Set<string>;
  readonly byId: ReadonlyMap<string, SourceRecord>;
  readonly pointBudget: { remaining: number };
}

interface Transform {
  readonly x: number;
  readonly y: number;
  readonly radians: number;
  readonly opacity: number;
}

export function* tldrawElementSteps(
  shape: SourceRecord,
  index: number,
  context: TldrawElementContext,
): Generator<void, InkElementV1> {
  const props = record(shape.props, "Tldraw shape properties");
  if (props.text !== undefined && props.text !== "") unsupported("Shape text cannot be imported.");
  const transform = shapeTransform(shape, context.byId);
  const base = {
    id: targetId(index),
    createdAt: context.timestamp,
    rotation: rotation((transform.radians * 180) / Math.PI),
    pivot: { x: transform.x + PAGE_MARGIN, y: transform.y + PAGE_MARGIN },
  };
  if (shape.type === "draw" || shape.type === "highlight") {
    const sourcePoints = yield* drawPointsSteps(props);
    const points = yield* legacyStrokePointsSteps(sourcePoints, context.pointBudget.remaining);
    context.pointBudget.remaining -= points.length / 3;
    if (props.isClosed === true)
      context.warnings.add("Closed freehand paths use Inkbook's native open stroke caps.");
    return {
      ...base,
      kind: "stroke",
      tool: shape.type === "highlight" ? "highlighter" : "pen",
      points,
      offset: { ...base.pivot },
      style: tldrawStrokeStyle(
        props,
        transform.opacity,
        shape.type === "highlight",
        context.warnings,
      ),
    };
  }
  if (shape.type === "line" || shape.type === "arrow") {
    return tldrawLinear(shape, props, base, transform, context);
  }
  if (shape.type !== "geo") unsupported(`Unsupported tldraw shape type: ${String(shape.type)}.`);
  return tldrawBox(props, base, transform, context);
}

/** Legacy free/straight segments retain their saved polyline and native editable brush. */
function* legacyStrokePointsSteps(
  points: readonly number[],
  remaining: number,
): Generator<void, number[]> {
  const at = (index: number) => ({
    x: points[index]!,
    y: points[index + 1]!,
    pressure: points[index + 2]!,
  });
  const segments: SourceStrokeCurveSegment[] = [];
  for (let index = 3; index < points.length; index += 3) {
    segments.push({ kind: "line", end: at(index), sharpEnd: true });
    yield;
  }
  return yield* sampleSourceStrokeCurveSteps(
    { start: at(0), segments, approximate: true },
    remaining,
  );
}

function* drawPointsSteps(props: SourceRecord): Generator<void, number[]> {
  const points: number[] = [];
  const scale = optionalNumber(props.scale, 1, "Stroke scale");
  for (const item of array(props.segments, "Stroke segments")) {
    const segment = record(item, "Stroke segment");
    if (segment.type !== "free" && segment.type !== "straight")
      unsupported("Unsupported stroke segment type.");
    for (const value of array(segment.points, "Segment points")) {
      const sample = record(value, "Stroke sample");
      const x = finite(sample.x, "Sample x") * scale;
      const y = finite(sample.y, "Sample y") * scale;
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        Math.abs(x) > FILE_SCHEMA_LIMITS.absoluteCoordinate ||
        Math.abs(y) > FILE_SCHEMA_LIMITS.absoluteCoordinate
      ) {
        invalid("A legacy stroke point exceeds Inkbook's coordinate capacity.");
      }
      points.push(x, y, unit(sample.z, 0.5));
      if (points.length / 3 > FILE_SCHEMA_LIMITS.pointsPerStroke)
        unsupported("A legacy stroke exceeds Inkbook's point capacity.");
      yield;
    }
  }
  if (points.length === 0) invalid("A legacy stroke has no points.");
  return points;
}

function shapeTransform(
  shape: SourceRecord,
  byId: ReadonlyMap<string, SourceRecord>,
  depth = 0,
): Transform {
  if (depth > 32) invalid("Cyclic or excessive shape parent hierarchy.");
  const local = {
    x: finite(shape.x, "Shape x"),
    y: finite(shape.y, "Shape y"),
    radians: optionalNumber(shape.rotation, 0, "Shape rotation"),
    opacity: unit(shape.opacity, 1),
  };
  const parentId = text(shape.parentId, "Shape parent");
  if (parentId.startsWith("page:")) return local;
  const parent = byId.get(parentId);
  if (parent === undefined || parent.type !== "group") unsupported("Unsupported shape parent.");
  const ancestor = shapeTransform(parent, byId, depth + 1);
  const position = worldPoint(local, ancestor);
  return {
    ...position,
    radians: local.radians + ancestor.radians,
    opacity: local.opacity * ancestor.opacity,
  };
}

function worldPoint(value: PointV1, transform: Transform): PointV1 {
  return {
    x: transform.x + value.x * Math.cos(transform.radians) - value.y * Math.sin(transform.radians),
    y: transform.y + value.x * Math.sin(transform.radians) + value.y * Math.cos(transform.radians),
  };
}

type Base = { id: string; createdAt: number; rotation: number; pivot: PointV1 };

function tldrawLinear(
  shape: SourceRecord,
  props: SourceRecord,
  base: Base,
  transform: Transform,
  context: TldrawElementContext,
): InkElementV1 {
  const local = shape.type === "arrow" ? undefined : linearPoints(props);
  const first =
    local === undefined
      ? arrowTerminal(props.start, transform, context)
      : worldPoint(local[0]!, transform);
  const last =
    local === undefined
      ? arrowTerminal(props.end, transform, context)
      : worldPoint(local[local.length - 1]!, transform);
  const start = { x: first.x + PAGE_MARGIN, y: first.y + PAGE_MARGIN };
  const end = { x: last.x + PAGE_MARGIN, y: last.y + PAGE_MARGIN };
  const bendValue = optionalNumber(props.bend, 0, "Arrow bend");
  let bend: PointV1 | null = null;
  if (bendValue !== 0) {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0) invalid("A bent arrow has coincident endpoints.");
    bend = {
      x: (start.x + end.x) / 2 + ((end.y - start.y) / length) * bendValue,
      y: (start.y + end.y) / 2 - ((end.x - start.x) / length) * bendValue,
    };
    context.warnings.add("Curved arrows use Inkbook's native bend geometry.");
  }
  return {
    ...base,
    kind: shape.type,
    rotation: 0,
    start,
    end,
    bend,
    startConnection: null,
    endConnection: null,
    startNode: shape.type === "arrow" ? tldrawArrowNode(props.arrowheadStart) : "none",
    endNode: shape.type === "arrow" ? tldrawArrowNode(props.arrowheadEnd ?? "arrow") : "none",
    style: tldrawOutlineStyle(props, transform.opacity, context.warnings),
  } as InkElementV1;
}

function arrowTerminal(
  value: unknown,
  transform: Transform,
  context: TldrawElementContext,
): PointV1 {
  const terminal = record(value, "Arrow terminal");
  if (terminal.type === "point") return worldPoint(point(terminal), transform);
  if (terminal.type !== "binding") unsupported("Unsupported arrow terminal.");
  const target = context.byId.get(text(terminal.boundShapeId, "Bound shape id"));
  if (target === undefined) invalid("Arrow binding target is missing.");
  const props = record(target.props, "Bound shape properties");
  const anchor = point(terminal.normalizedAnchor);
  const width = finite(props.w, "Bound shape width");
  const height =
    finite(props.h, "Bound shape height") + optionalNumber(props.growY, 0, "Bound shape growth");
  context.warnings.add("Legacy arrow bindings were detached at their saved normalized anchors.");
  return worldPoint(
    { x: width * anchor.x, y: height * anchor.y },
    shapeTransform(target, context.byId),
  );
}

function linearPoints(props: SourceRecord): PointV1[] {
  const handles = Object.values(record(props.handles ?? props.points, "Line handles"));
  if (handles.length !== 2) unsupported("Only two-endpoint legacy lines are supported.");
  const sorted = handles
    .map((value) => record(value, "Line handle"))
    .sort((a, b) => String(a.index).localeCompare(String(b.index)));
  if (props.spline !== undefined && props.spline !== "line")
    unsupported("Unsupported legacy line spline.");
  return sorted.map(point);
}

function tldrawBox(
  props: SourceRecord,
  base: Base,
  transform: Transform,
  context: TldrawElementContext,
): InkElementV1 {
  const kinds = new Map<
    string,
    "rectangle" | "ellipse" | "triangle" | "diamond" | "octagon" | "parallelogram"
  >([
    ["rectangle", "rectangle"],
    ["ellipse", "ellipse"],
    ["triangle", "triangle"],
    ["diamond", "diamond"],
    ["octagon", "octagon"],
    ["rhombus", "parallelogram"],
  ]);
  const kind = kinds.get(text(props.geo, "Geometry type"));
  if (kind === undefined) unsupported("Unsupported legacy geometry type.");
  const width = finite(props.w, "Shape width");
  const height = finite(props.h, "Shape height") + optionalNumber(props.growY, 0, "Shape growth");
  const center = worldPoint({ x: width / 2, y: height / 2 }, transform);
  const pivot = { x: center.x + PAGE_MARGIN, y: center.y + PAGE_MARGIN };
  return {
    ...base,
    kind,
    pivot,
    x: pivot.x - width / 2,
    y: pivot.y - height / 2,
    width,
    height,
    style: tldrawShapeStyle(props, transform.opacity, context.warnings),
  };
}
