import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import { smoothStrokeCenters } from "../../domain/geometry/stroke-path";
import { simplifyStrokeCenters } from "../../domain/geometry/stroke-simplification";
import { pressureStrokeContainsPoint } from "./pressure-hit-test";
import type { RenderBand } from "../../domain/commands/render-bands";
import { isStoredStroke } from "../../domain/elements/stroke-replacement-proof";
import { shapeVertices, tableColumnOffsets, tableWidth } from "../../domain/geometry/creation";
import { effectiveStrokeWidth } from "../../domain/geometry/bounds";
import {
  pointInPolygon,
  pointSegmentDistance,
  quadraticPoint,
  rotatePointClockwise,
} from "../../domain/geometry/public";
import type { BoxShapeElementV1, InkElementV1, PointV1 } from "../../domain/schema/public";

export class HitTestScratch {
  #active = false;
  #element: InkElementV1 | undefined;
  #hitBand: RenderBand | undefined;
  #hitId: string | null = null;
  #hitRank = 0;
  #pointer: PointV1 = { x: 0, y: 0 };
  #tolerance = 0;

  public begin(point: PointV1, pointerType: "mouse" | "pen" | "touch", zoom: number): void {
    this.#active = Number.isFinite(zoom) && zoom > 0;
    this.#element = undefined;
    this.#hitBand = undefined;
    this.#hitId = null;
    this.#hitRank = 0;
    this.#pointer.x = point.x;
    this.#pointer.y = point.y;
    this.#tolerance = this.#active ? hitTolerancePixels(pointerType) / zoom : 0;
  }

  public consider(
    id: string,
    band: RenderBand,
    element: InkElementV1,
    rank: number,
    prepared?: PreparedPressureGeometryPort,
  ): void {
    if (!this.#active || !this.#canOutrank(band, rank, id)) return;
    if (!elementContainsPoint(element, this.#pointer, this.#tolerance, prepared)) return;
    this.#element = element;
    this.#hitBand = band;
    this.#hitId = id;
    this.#hitRank = rank;
  }

  public finish(): string | null {
    const id = this.#hitId;
    this.#active = false;
    this.#element = undefined;
    this.#hitBand = undefined;
    this.#hitId = null;
    this.#pointer.x = 0;
    this.#pointer.y = 0;
    return id;
  }

  #canOutrank(band: RenderBand, rank: number, id: string): boolean {
    if (this.#hitId === null || this.#hitBand === undefined || this.#element === undefined) {
      return true;
    }
    return (
      (band === "content" && this.#hitBand === "highlight") ||
      (band === this.#hitBand &&
        (rank > this.#hitRank || (rank === this.#hitRank && id.localeCompare(this.#hitId) < 0)))
    );
  }
}

const STROKE_HIT_BLOCK_SEGMENTS = 64;
const strokeHitIndexes = new WeakMap<object, StrokeHitIndex>();

interface StrokeHitIndex {
  readonly samples: readonly number[];
  readonly width: number;
  readonly bounds: Float64Array;
  readonly pointCount: number;
}

function hitTolerancePixels(pointerType: "mouse" | "pen" | "touch"): number {
  return pointerType === "touch" ? 14 : 8;
}

export function elementContainsPoint(
  element: InkElementV1,
  pagePoint: PointV1,
  tolerance: number,
  prepared?: PreparedPressureGeometryPort,
): boolean {
  if (!Number.isFinite(tolerance) || tolerance < 0) return false;
  const point = rotatePointClockwise(pagePoint, element.pivot, -element.rotation);
  if (element.kind === "stroke") {
    point.x -= element.offset?.x ?? 0;
    point.y -= element.offset?.y ?? 0;
    return element.style.pressureEnabled
      ? pressureStrokeContainsPoint(element, pagePoint, tolerance, prepared)
      : hitStroke(element, point, tolerance + effectiveStrokeWidth(element) / 2);
  }
  if (
    element.kind === "line" ||
    element.kind === "arrow" ||
    element.kind === "straight-highlighter"
  )
    return linearElementHit(element, point, tolerance);
  if (element.kind === "coordinate-system") return coordinateSystemHit(element, point, tolerance);
  if (element.kind === "table") return tableHit(element, point, tolerance);
  const radius = tolerance + element.style.outlineWidth / 2;
  if (element.kind === "ellipse") return ellipseHit(element, point, radius);
  const vertices = shapeVertices(element);
  return (
    polygonOutlineHit(vertices, point, radius) ||
    (element.style.fillColor !== null &&
      element.style.fillOpacity > 0 &&
      pointInPolygon(point, vertices))
  );
}

function linearElementHit(
  element:
    | Extract<InkElementV1, { kind: "line" }>
    | Extract<InkElementV1, { kind: "arrow" }>
    | Extract<InkElementV1, { kind: "straight-highlighter" }>,
  point: PointV1,
  tolerance: number,
): boolean {
  const width =
    element.kind === "straight-highlighter"
      ? effectiveStrokeWidth(element)
      : element.style.outlineWidth;
  return hitLinear(element.start, element.end, element.bend, point, tolerance + width / 2);
}

function coordinateSystemHit(
  element: Extract<InkElementV1, { kind: "coordinate-system" }>,
  point: PointV1,
  tolerance: number,
): boolean {
  return element.axes.some(
    (axis) =>
      pointSegmentDistance(point, element.origin, axis) <=
      tolerance + element.style.outlineWidth / 2,
  );
}

function tableHit(
  element: Extract<InkElementV1, { kind: "table" }>,
  point: PointV1,
  tolerance: number,
): boolean {
  const right = element.x + tableWidth(element);
  const bottom = element.y + element.height;
  const radius = tolerance + element.style.outlineWidth / 2;
  if (
    Math.abs(point.y - (element.y + element.headerHeight)) <= radius &&
    point.x >= element.x - radius &&
    point.x <= right + radius
  ) {
    return true;
  }
  for (const offset of tableColumnOffsets(element)) {
    const x = element.x + offset;
    if (
      Math.abs(point.x - x) <= radius &&
      point.y >= element.y - radius &&
      point.y <= bottom + radius
    ) {
      return true;
    }
  }
  return false;
}

function hitStroke(
  stroke: Extract<InkElementV1, { kind: "stroke" }>,
  point: PointV1,
  radius: number,
): boolean {
  const samples = stroke.points;
  if (samples.length < 3 || stroke.style.opacity <= 0) return false;
  const radiusSquared = radius * radius;
  if (pointDistanceSquared(point.x, point.y, samples[0]!, samples[1]!) <= radiusSquared)
    return true;
  const index = getStrokeHitIndex(stroke);
  for (let block = 0; block * STROKE_HIT_BLOCK_SEGMENTS + 1 < index.pointCount; block += 1) {
    const offset = block * 4;
    if (!blockMayContainPoint(index.bounds, offset, point, radius)) continue;
    const firstPoint = block * STROKE_HIT_BLOCK_SEGMENTS + 1;
    const lastPoint = Math.min(index.pointCount - 1, (block + 1) * STROKE_HIT_BLOCK_SEGMENTS);
    if (hitStrokeBlock(index.samples, point, radiusSquared, firstPoint, lastPoint)) return true;
  }
  return false;
}

function getStrokeHitIndex(stroke: Extract<InkElementV1, { kind: "stroke" }>): StrokeHitIndex {
  const samples = stroke.points;
  const cacheable = Object.isFrozen(samples) || isOwnedRuntimeStroke(stroke);
  if (cacheable) {
    const cached = strokeHitIndexes.get(samples);
    if (cached?.width === stroke.style.width) return cached;
  }
  const created = createStrokeHitIndex(samples, stroke.style.width);
  if (cacheable) strokeHitIndexes.set(samples, created);
  return created;
}

function isOwnedRuntimeStroke(stroke: Extract<InkElementV1, { kind: "stroke" }>): boolean {
  return stroke.points instanceof Float64Array && isStoredStroke(stroke);
}

function createStrokeHitIndex(input: readonly number[], width: number): StrokeHitIndex {
  const samples = simplifyStrokeCenters(smoothStrokeCenters(input), width, false).flatMap(
    (center) => [center.x, center.y, center.pressure],
  );
  const pointCount = samples.length / 3;
  const blockCount = Math.ceil(Math.max(0, pointCount - 1) / STROKE_HIT_BLOCK_SEGMENTS);
  const bounds = new Float64Array(blockCount * 4);
  for (let block = 0; block < blockCount; block += 1) {
    const firstPoint = block * STROKE_HIT_BLOCK_SEGMENTS;
    const lastPoint = Math.min(pointCount - 1, (block + 1) * STROKE_HIT_BLOCK_SEGMENTS);
    writeStrokeBlockBounds(samples, bounds, block * 4, firstPoint, lastPoint);
  }
  return { bounds, pointCount, samples, width };
}

function writeStrokeBlockBounds(
  samples: readonly number[],
  bounds: Float64Array,
  offset: number,
  firstPoint: number,
  lastPoint: number,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let point = firstPoint; point <= lastPoint; point += 1) {
    const sample = point * 3;
    const x = samples[sample]!;
    const y = samples[sample + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  bounds[offset] = minX;
  bounds[offset + 1] = minY;
  bounds[offset + 2] = maxX;
  bounds[offset + 3] = maxY;
}

function blockMayContainPoint(
  bounds: Float64Array,
  offset: number,
  point: PointV1,
  radius: number,
): boolean {
  return (
    point.x >= bounds[offset]! - radius &&
    point.y >= bounds[offset + 1]! - radius &&
    point.x <= bounds[offset + 2]! + radius &&
    point.y <= bounds[offset + 3]! + radius
  );
}

function hitStrokeBlock(
  samples: readonly number[],
  point: PointV1,
  radiusSquared: number,
  firstPoint: number,
  lastPoint: number,
): boolean {
  let previousSample = (firstPoint - 1) * 3;
  for (let sample = firstPoint * 3; sample <= lastPoint * 3; sample += 3) {
    if (
      segmentDistanceSquared(
        point,
        samples[previousSample]!,
        samples[previousSample + 1]!,
        samples[sample]!,
        samples[sample + 1]!,
      ) <= radiusSquared
    )
      return true;
    previousSample = sample;
  }
  return false;
}

function segmentDistanceSquared(
  point: PointV1,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const dx = endX - startX;
  const dy = endY - startY;
  const squaredLength = dx * dx + dy * dy;
  const ratio =
    squaredLength === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - startX) * dx + (point.y - startY) * dy) / squaredLength),
        );
  return pointDistanceSquared(point.x, point.y, startX + ratio * dx, startY + ratio * dy);
}

function pointDistanceSquared(
  leftX: number,
  leftY: number,
  rightX: number,
  rightY: number,
): number {
  const dx = leftX - rightX;
  const dy = leftY - rightY;
  return dx * dx + dy * dy;
}

function hitLinear(
  start: PointV1,
  end: PointV1,
  bend: PointV1 | null,
  point: PointV1,
  radius: number,
): boolean {
  if (bend === null) return pointSegmentDistance(point, start, end) <= radius;
  let previous = start;
  for (let step = 1; step <= 24; step += 1) {
    const current = quadraticPoint(start, bend, end, step / 24);
    if (pointSegmentDistance(point, previous, current) <= radius) return true;
    previous = current;
  }
  return false;
}

function ellipseHit(ellipse: BoxShapeElementV1, point: PointV1, radius: number): boolean {
  const rx = ellipse.width / 2;
  const ry = ellipse.height / 2;
  if (rx === 0 || ry === 0) {
    return (
      pointSegmentDistance(
        point,
        { x: ellipse.x, y: ellipse.y },
        {
          x: ellipse.x + ellipse.width,
          y: ellipse.y + ellipse.height,
        },
      ) <= radius
    );
  }
  const center = { x: ellipse.x + rx, y: ellipse.y + ry };
  const normalized = Math.hypot((point.x - center.x) / rx, (point.y - center.y) / ry);
  const edgeTolerance = radius / Math.max(1, Math.min(rx, ry));
  if (Math.abs(normalized - 1) <= edgeTolerance) return true;
  return ellipse.style.fillColor !== null && ellipse.style.fillOpacity > 0 && normalized < 1;
}

function polygonOutlineHit(vertices: readonly PointV1[], point: PointV1, radius: number): boolean {
  return vertices.some((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return next !== undefined && pointSegmentDistance(point, vertex, next) <= radius;
  });
}
