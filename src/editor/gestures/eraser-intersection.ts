import { effectiveStrokeWidth } from "../../domain/geometry/bounds";
import { shapeVertices, tableLineSegments } from "../../domain/geometry/creation";
import { pointInPolygon, quadraticPoint } from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";
import {
  pointSegmentDistanceSquared,
  segmentBoundsOverlap,
  segmentDistanceSquared,
  type NumericSegment,
} from "./eraser-segment";
import {
  EraserStrokeIndexCursor,
  type EraserStrokeIndex,
  type EraserStrokeIndexCache,
} from "./eraser-stroke-index";

const CURVE_SEGMENTS = 24;

type LinearElement = Extract<InkElementV1, { kind: "line" | "arrow" | "straight-highlighter" }>;
type CheckMode = "coordinate-system" | "ellipse" | "linear" | "polygon" | "segments" | "stroke";

export interface SweptCapsuleCheck {
  advance(workUnits: number): SweptCapsuleCheckProgress;
}

interface SweptCapsuleCheckProgress {
  readonly result: boolean | null;
  readonly workUnits: number;
}

export function createSweptCapsuleCheck(
  pageStart: PointV1,
  pageEnd: PointV1,
  radius: number,
  element: InkElementV1,
  cache?: EraserStrokeIndexCache,
): SweptCapsuleCheck {
  return new ResumableSweptCapsuleCheck(pageStart, pageEnd, radius, element, cache);
}

class ResumableSweptCapsuleCheck implements SweptCapsuleCheck {
  readonly #element: InkElementV1;
  readonly #localEnd: PointV1;
  readonly #localStart: PointV1;
  readonly #sweep: NumericSegment;
  readonly #strokeCache: EraserStrokeIndexCache | undefined;
  #mode!: CheckMode;
  #radius: number;
  #coordinateIndex = 0;
  #finished = false;
  #linearElement: LinearElement | null = null;
  #linearPrevious: PointV1 | null = null;
  #linearStep = 1;
  #polygonFillPending = false;
  #polygonIndex = 0;
  readonly #progress: { result: boolean | null; workUnits: number } = {
    result: null,
    workUnits: 0,
  };
  #segments: readonly (readonly [PointV1, PointV1])[] = [];
  #strokeIndex = 3;
  #strokeLine: NumericSegment | null = null;
  #strokeIndexEntry: EraserStrokeIndex | null = null;
  #strokeIndexCursor: EraserStrokeIndexCursor | null = null;
  #strokeRecordPending = false;
  #indexedPreviousSegment = -2;
  #touches = false;
  #vertices: readonly PointV1[] = [];

  public constructor(
    start: PointV1,
    end: PointV1,
    radius: number,
    element: InkElementV1,
    cache?: EraserStrokeIndexCache,
  ) {
    this.#element = element;
    this.#strokeCache = cache;
    this.#sweep = localSweep(start, end, element);
    this.#localStart = { x: this.#sweep.startX, y: this.#sweep.startY };
    this.#localEnd = { x: this.#sweep.endX, y: this.#sweep.endY };
    this.#radius = radius;
    if (element.kind === "stroke") {
      this.#mode = "stroke";
      this.#radius += effectiveStrokeWidth(element) / 2;
      this.#strokeIndexEntry = cache?.acquire(element) ?? null;
      if (this.#strokeIndexEntry?.scanned === true) {
        this.#strokeIndexCursor = new EraserStrokeIndexCursor(this.#strokeIndexEntry);
      }
      if (element.points.length < 3) this.#finished = true;
      else if (element.points.length > 3) {
        this.#strokeLine = {
          endX: this.#strokeIndexCursor === null ? element.points[3]! : 0,
          endY: this.#strokeIndexCursor === null ? element.points[4]! : 0,
          startX: this.#strokeIndexCursor === null ? element.points[0]! : 0,
          startY: this.#strokeIndexCursor === null ? element.points[1]! : 0,
        };
      }
      return;
    }
    if (
      element.kind === "line" ||
      element.kind === "arrow" ||
      element.kind === "straight-highlighter"
    ) {
      this.#mode = "linear";
      this.#linearElement = element;
      this.#linearPrevious = element.start;
      return;
    }
    const outlineRadius = radius + element.style.outlineWidth / 2;
    if (element.kind === "coordinate-system") {
      this.#mode = "coordinate-system";
      this.#segments = element.axes.map((axis) => [element.origin, axis]);
      this.#radius = outlineRadius;
      return;
    }
    if (element.kind === "table") {
      this.#mode = "segments";
      this.#segments = tableLineSegments(element);
      this.#radius = outlineRadius;
      return;
    }
    if (element.kind === "ellipse") {
      this.#mode = "ellipse";
      this.#radius = outlineRadius;
      return;
    }
    this.#mode = "polygon";
    this.#vertices = shapeVertices(element);
    this.#radius = outlineRadius;
    this.#polygonFillPending = true;
  }

  public advance(workUnits: number): SweptCapsuleCheckProgress {
    if (this.#finished) {
      this.#progress.result = this.#touches;
      this.#progress.workUnits = 0;
      return this.#progress;
    }
    let remaining = Number.isFinite(workUnits) ? Math.floor(workUnits) : Number.MAX_SAFE_INTEGER;
    const budget = Math.max(0, remaining);
    while (remaining > 0 && !this.#finished) {
      remaining -= 1;
      this.advanceOne();
    }
    if (
      this.#finished &&
      !this.#touches &&
      this.#strokeIndexEntry === null &&
      this.#element.kind === "stroke"
    ) {
      this.#strokeCache?.rememberMiss(this.#element);
    }
    this.#progress.result = this.#finished ? this.#touches : null;
    this.#progress.workUnits = budget - remaining;
    return this.#progress;
  }

  private advanceOne(): void {
    if (this.#mode === "stroke") return this.advanceStroke();
    if (this.#mode === "linear") return this.advanceLinear();
    if (this.#mode === "ellipse") {
      this.#touches = ellipseTouches(
        this.#localStart,
        this.#localEnd,
        this.#radius,
        this.#element as Extract<InkElementV1, { kind: "ellipse" }>,
      );
      this.#finished = true;
      return;
    }
    if (this.#mode === "polygon") return this.advancePolygon();
    this.advanceSegments();
  }

  private advanceStroke(): void {
    const element = this.#element;
    if (element.kind !== "stroke") {
      this.#finished = true;
      return;
    }
    const sweep = this.#sweep;
    if (this.#strokeIndexCursor !== null) return this.advanceIndexedStroke();
    if (element.points.length === 3) {
      this.#touches =
        pointSegmentDistanceSquared(element.points[0]!, element.points[1]!, sweep) <=
        this.#radius * this.#radius;
      this.#finished = true;
      return;
    }
    const line = this.#strokeLine;
    if (line === null || this.#strokeIndex >= element.points.length) {
      this.#finished = true;
      return;
    }
    if (this.#strokeRecordPending) {
      this.#strokeIndexEntry!.record(this.#strokeIndex / 3 - 1, line);
      this.#strokeRecordPending = false;
      this.advanceStrokeLine(line);
      return;
    }
    line.endX = element.points[this.#strokeIndex]!;
    line.endY = element.points[this.#strokeIndex + 1]!;
    if (
      segmentBoundsOverlap(sweep, line, this.#radius) &&
      segmentDistanceSquared(sweep, line) <= this.#radius * this.#radius
    ) {
      this.#touches = true;
      this.#finished = true;
      return;
    }
    if (this.#strokeIndexEntry !== null) this.#strokeRecordPending = true;
    else this.advanceStrokeLine(line);
  }

  private advanceStrokeLine(line: NumericSegment): void {
    line.startX = line.endX;
    line.startY = line.endY;
    this.#strokeIndex += 3;
    if (
      this.#strokeIndex >=
      (this.#element as Extract<InkElementV1, { kind: "stroke" }>).points.length
    ) {
      this.#finished = true;
    }
  }

  private advanceIndexedStroke(): void {
    const cursor = this.#strokeIndexCursor!;
    const index = cursor.advance(this.#sweep, this.#radius);
    const element = this.#element as Extract<InkElementV1, { kind: "stroke" }>;
    if (index !== null) {
      const line = this.#strokeLine!;
      line.startX =
        index === this.#indexedPreviousSegment + 1 ? line.endX : element.points[index * 3]!;
      line.startY =
        index === this.#indexedPreviousSegment + 1 ? line.endY : element.points[index * 3 + 1]!;
      line.endX = element.points[index * 3 + 3]!;
      line.endY = element.points[index * 3 + 4]!;
      this.#indexedPreviousSegment = index;
      this.#touches =
        segmentBoundsOverlap(this.#sweep, line, this.#radius) &&
        segmentDistanceSquared(this.#sweep, line) <= this.#radius * this.#radius;
    }
    if (this.#touches || cursor.done) this.#finished = true;
  }

  private advanceLinear(): void {
    const element = this.#linearElement;
    if (element === null) {
      this.#finished = true;
      return;
    }
    const radius =
      this.#radius +
      (element.kind === "straight-highlighter"
        ? effectiveStrokeWidth(element)
        : element.style.outlineWidth) /
        2;
    if (element.bend === null) {
      this.#touches = segmentsWithin(
        this.#localStart,
        this.#localEnd,
        element.start,
        element.end,
        radius,
      );
      this.#finished = true;
      return;
    }
    const previous = this.#linearPrevious ?? element.start;
    const current = quadraticPoint(
      element.start,
      element.bend,
      element.end,
      this.#linearStep / CURVE_SEGMENTS,
    );
    this.#touches = segmentsWithin(this.#localStart, this.#localEnd, previous, current, radius);
    this.#linearPrevious = current;
    this.#linearStep += 1;
    if (this.#touches || this.#linearStep > CURVE_SEGMENTS) this.#finished = true;
  }

  private advanceSegments(): void {
    const segment = this.#segments[this.#coordinateIndex];
    if (segment === undefined) {
      this.#finished = true;
      return;
    }
    this.#touches = segmentsWithin(
      this.#localStart,
      this.#localEnd,
      segment[0],
      segment[1],
      this.#radius,
    );
    this.#coordinateIndex += 1;
    if (this.#touches || this.#coordinateIndex >= this.#segments.length) this.#finished = true;
  }

  private advancePolygon(): void {
    if (this.#polygonIndex < this.#vertices.length) {
      const vertex = this.#vertices[this.#polygonIndex]!;
      const next = this.#vertices[(this.#polygonIndex + 1) % this.#vertices.length];
      this.#polygonIndex += 1;
      this.#touches =
        next !== undefined &&
        segmentsWithin(this.#localStart, this.#localEnd, vertex, next, this.#radius);
      if (this.#touches) this.#finished = true;
      return;
    }
    if (!this.#polygonFillPending) {
      this.#finished = true;
      return;
    }
    this.#polygonFillPending = false;
    const element = this.#element;
    if (
      element.kind !== "rectangle" &&
      element.kind !== "ellipse" &&
      element.kind !== "triangle" &&
      element.kind !== "octagon" &&
      element.kind !== "parallelogram" &&
      element.kind !== "diamond"
    ) {
      this.#finished = true;
      return;
    }
    this.#touches =
      element.style.fillColor !== null &&
      element.style.fillOpacity > 0 &&
      (pointInPolygon(this.#localStart, this.#vertices) ||
        pointInPolygon(this.#localEnd, this.#vertices));
    this.#finished = true;
  }
}

function ellipseTouches(
  start: PointV1,
  end: PointV1,
  radius: number,
  element: Extract<InkElementV1, { kind: "ellipse" }>,
): boolean {
  const center = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
  const rx = element.width / 2 + radius;
  const ry = element.height / 2 + radius;
  const innerRx = Math.max(0, element.width / 2 - radius);
  const innerRy = Math.max(0, element.height / 2 - radius);
  const touchesOuter =
    segmentIntersectsEllipse(start, end, center, rx, ry) ||
    pointInsideEllipse(start, center, rx, ry) ||
    pointInsideEllipse(end, center, rx, ry);
  if (!touchesOuter) return false;
  if (element.style.fillColor !== null && element.style.fillOpacity > 0) return true;
  return !(
    pointInsideEllipse(start, center, innerRx, innerRy) &&
    pointInsideEllipse(end, center, innerRx, innerRy)
  );
}

function segmentIntersectsEllipse(
  start: PointV1,
  end: PointV1,
  center: PointV1,
  rx: number,
  ry: number,
): boolean {
  const sx = (start.x - center.x) / rx;
  const sy = (start.y - center.y) / ry;
  const dx = (end.x - start.x) / rx;
  const dy = (end.y - start.y) / ry;
  const squaredLength = dx * dx + dy * dy;
  const ratio = squaredLength === 0 ? 0 : clamp01(-(sx * dx + sy * dy) / squaredLength);
  const closestX = sx + ratio * dx;
  const closestY = sy + ratio * dy;
  return closestX * closestX + closestY * closestY <= 1;
}

function pointInsideEllipse(point: PointV1, center: PointV1, rx: number, ry: number): boolean {
  const x = (point.x - center.x) / rx;
  const y = (point.y - center.y) / ry;
  return x * x + y * y < 1;
}

function segmentsWithin(
  sweepStart: PointV1,
  sweepEnd: PointV1,
  lineStart: PointV1,
  lineEnd: PointV1,
  radius: number,
): boolean {
  const sweep = numericSegment(sweepStart, sweepEnd);
  const line = numericSegment(lineStart, lineEnd);
  if (!segmentBoundsOverlap(sweep, line, radius)) return false;
  return segmentDistanceSquared(sweep, line) <= radius * radius;
}

function numericSegment(start: PointV1, end: PointV1): NumericSegment {
  return { endX: end.x, endY: end.y, startX: start.x, startY: start.y };
}

/** Preserve the existing transform arithmetic while sharing its fixed rotation. */
function localSweep(start: PointV1, end: PointV1, element: InkElementV1): NumericSegment {
  const radians = (-element.rotation * Math.PI) / 180;
  const cosine = element.rotation === 0 ? 1 : Math.cos(radians);
  const sine = element.rotation === 0 ? -element.rotation : Math.sin(radians);
  const startX = start.x - element.pivot.x;
  const startY = start.y - element.pivot.y;
  const endX = end.x - element.pivot.x;
  const endY = end.y - element.pivot.y;
  const sweep = {
    startX: element.pivot.x + (startX * cosine - startY * sine),
    startY: element.pivot.y + (startX * sine + startY * cosine),
    endX: element.pivot.x + (endX * cosine - endY * sine),
    endY: element.pivot.y + (endX * sine + endY * cosine),
  };
  if (element.kind === "stroke" && element.offset !== undefined) {
    sweep.startX -= element.offset.x;
    sweep.startY -= element.offset.y;
    sweep.endX -= element.offset.x;
    sweep.endY -= element.offset.y;
  }
  return sweep;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
