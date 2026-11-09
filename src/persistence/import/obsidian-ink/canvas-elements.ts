import type { ObsidianInkWarningCode } from "./warnings";
import { FILE_SCHEMA_LIMITS, PAGE_MARGIN } from "../../../domain/schema/constants";
import type { InkElementV1, PointV1, StrokeElementV1 } from "../../../domain/schema/types";
import { outlineStyle, sourceColor, strokeStyle } from "./source-style";
import { sourceStrokeCurveSteps } from "./source-stroke-curve";
import { sampleSourceStrokeCurveSteps } from "./stroke-geometry";
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
  ObsidianInkImportError,
  type SourceRecord,
} from "./source-values";

export interface CanvasContext {
  readonly version: number;
  readonly styles: unknown[];
  readonly timeBase: number;
  readonly timestamp: number;
  readonly warnings: Set<ObsidianInkWarningCode>;
  readonly pointBudget: { remaining: number };
}

export function* canvasStrokeSteps(
  value: SourceRecord,
  index: number,
  context: CanvasContext,
): Generator<void, StrokeElementV1> {
  rejectGeometryOverrides(value.extra);
  if (value.kind !== undefined && value.kind !== "stroke")
    unsupported("Unsupported canvas element.");
  const styleValue =
    context.version === 3 ? context.styles[finite(value.style, "Style index")] : value.style;
  const style = record(styleValue, "Stroke style");
  if (style.brush !== undefined && style.brush !== "pen" && style.brush !== "highlighter") {
    unsupported("Unsupported stroke brush.");
  }
  const sourcePoints = yield* canvasPointsSteps(
    array(value.points, "Stroke points"),
    context.version,
    context.pointBudget.remaining,
  );
  const curve = yield* sourceStrokeCurveSteps(
    sourcePoints,
    style,
    context.version,
    context.warnings,
  );
  const points = yield* sampleSourceStrokeCurveSteps(curve, context.pointBudget.remaining);
  context.pointBudget.remaining -= points.length / 3;
  const offset = canvasOffset(value.offset, context.version);
  const startedAt =
    context.version === 3
      ? optionalNumber(value.start, context.timestamp - context.timeBase, "Stroke start") +
        context.timeBase
      : optionalNumber(value.startedAt, context.timestamp, "Stroke start");
  if (value.extra !== undefined || value.finishedAt !== undefined || value.end !== undefined) {
    context.warnings.add("strokeMetadata");
  }
  return {
    kind: "stroke",
    id: targetId(index),
    createdAt: startedAt,
    rotation: 0,
    pivot: { x: 0, y: 0 },
    tool: style.brush === "highlighter" ? "highlighter" : "pen",
    points,
    offset: { x: offset.x + PAGE_MARGIN, y: offset.y + PAGE_MARGIN },
    style: strokeStyle(style, context.warnings, curve.targetWidth),
  };
}

function rejectGeometryOverrides(value: unknown): void {
  if (value === undefined) return;
  const extra = record(value, "Compact stroke extra metadata");
  const reserved = new Set([
    "id",
    "kind",
    "points",
    "style",
    "offset",
    "start",
    "end",
    "startedAt",
    "finishedAt",
    "source",
    "authoringSource",
    "rotation",
    "pivot",
    "shapeType",
  ]);
  if (Object.keys(extra).some((key) => reserved.has(key))) {
    unsupported("Compact stroke extra metadata overrides reserved element fields.");
  }
}

function* canvasPointsSteps(
  input: unknown[],
  version: number,
  remaining: number,
): Generator<void, number[]> {
  const count = version === 3 ? input.length / 3 : input.length;
  if (!Number.isInteger(count) || count < 1)
    invalid("A stroke must contain complete point triples.");
  if (count > FILE_SCHEMA_LIMITS.pointsPerStroke || count > remaining) {
    throw new ObsidianInkImportError(
      "capacity-exceeded",
      "A source stroke exceeds Inkbook's point capacity.",
    );
  }
  const result: number[] = [];
  let x = 0;
  let y = 0;
  let pressure = 0;
  for (let index = 0; index < count; index += 1) {
    if (version === 3) {
      const base = index * 3;
      const values = [input[base], input[base + 1], input[base + 2]];
      if (!values.every(Number.isSafeInteger))
        invalid("Compact stroke deltas must be safe integers.");
      x += finite(values[0], "Delta x");
      y += finite(values[1], "Delta y");
      pressure += finite(values[2], "Delta pressure");
      result.push(x / 100, y / 100, unit(pressure / 1000, 1));
    } else {
      const sample = array(input[index], "Stroke point");
      if (sample.length !== 2 && sample.length !== 3) invalid("Invalid stroke point tuple.");
      result.push(finite(sample[0], "Point x"), finite(sample[1], "Point y"), unit(sample[2], 1));
    }
    const offset = result.length - 3;
    if (
      Math.abs(result[offset]!) > FILE_SCHEMA_LIMITS.absoluteCoordinate ||
      Math.abs(result[offset + 1]!) > FILE_SCHEMA_LIMITS.absoluteCoordinate
    ) {
      invalid("A source stroke point exceeds Inkbook's coordinate capacity.");
    }
    yield;
  }
  return result;
}

function canvasOffset(value: unknown, version: number): PointV1 {
  if (value === undefined) return { x: 0, y: 0 };
  if (version !== 3) return point(value);
  const tuple = array(value, "Compact stroke offset");
  if (tuple.length !== 2 || !tuple.every(Number.isSafeInteger))
    invalid("Invalid compact stroke offset.");
  return { x: finite(tuple[0], "Offset x") / 100, y: finite(tuple[1], "Offset y") / 100 };
}

export function canvasShape(
  value: SourceRecord,
  index: number,
  context: CanvasContext,
): InkElementV1 {
  if (value.kind !== "shape") unsupported("Unsupported canvas shape discriminator.");
  const style = record(value.style, "Shape style");
  const outline = outlineStyle(style, context.warnings);
  const offset = value.offset === undefined ? { x: 0, y: 0 } : point(value.offset);
  const translation = { x: offset.x + PAGE_MARGIN, y: offset.y + PAGE_MARGIN };
  const base = {
    id: targetId(index),
    createdAt: context.timestamp,
    rotation: rotation(value.rotation),
    pivot: { x: 0, y: 0 },
  };
  const kind = text(value.shapeType, "Shape type");
  if (kind === "line" || kind === "arrow") {
    const start = translated(point(value.start), translation);
    const end = translated(point(value.end), translation);
    return {
      ...base,
      rotation: 0,
      kind,
      start,
      end,
      bend: null,
      startConnection: null,
      endConnection: null,
      startNode: kind === "arrow" && value.arrowheadStart === true ? "arrow" : "none",
      endNode: kind === "arrow" && value.arrowheadEnd !== false ? "arrow" : "none",
      style: outline,
    } as InkElementV1;
  }
  if (kind !== "rect" && kind !== "ellipse") unsupported(`Unsupported canvas shape type: ${kind}.`);
  const box = shapeBox(value, kind, translation);
  if (optionalNumber(value.cornerRadius, 0, "Corner radius") !== 0) {
    context.warnings.add("squareCorners");
  }
  return {
    ...base,
    ...box,
    kind: kind === "rect" ? "rectangle" : "ellipse",
    pivot: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    style: {
      ...outline,
      fillColor:
        style.fill === "none" || style.fill === undefined
          ? null
          : sourceColor(style.fill, context.warnings),
      fillOpacity: unit(style.opacity, 1),
    },
  };
}

function shapeBox(value: SourceRecord, kind: string, translation: PointV1) {
  if (kind === "rect") {
    return {
      x: finite(value.x, "Rectangle x") + translation.x,
      y: finite(value.y, "Rectangle y") + translation.y,
      width: finite(value.w, "Rectangle width"),
      height: finite(value.h, "Rectangle height"),
    };
  }
  const rx = finite(value.rx, "Ellipse x radius");
  const ry = finite(value.ry, "Ellipse y radius");
  return {
    x: finite(value.cx, "Ellipse center x") - rx + translation.x,
    y: finite(value.cy, "Ellipse center y") - ry + translation.y,
    width: rx * 2,
    height: ry * 2,
  };
}

function translated(value: PointV1, offset: PointV1): PointV1 {
  return { x: value.x + offset.x, y: value.y + offset.y };
}
