import {
  calculateElementBounds,
  canonicalPoint,
  effectiveStrokeWidth,
  rotatePointClockwise,
  type Bounds,
} from "../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../domain/schema/public";

import { oppositeBoxAnchor } from "./handles";
import {
  selectionFrameElementAtRotation,
  selectionFrameFromLocalBounds,
  selectionFramePoint,
  translateSelectionFrame,
  type OrientedSelectionFrame,
} from "./selection-frame";
import { uniformScaleFactorFromPointers, type ScaleFactors } from "./transforms";

interface Line {
  readonly id: string;
  readonly intercept: number;
  readonly slope: number;
}

interface PaintBoundsEntry {
  readonly id: string;
  readonly path: Bounds;
  readonly radius: number;
}

export class SelectionScalePreviewFramePlan {
  readonly #entries: readonly PaintBoundsEntry[];
  readonly #bottom: LinearEnvelope;
  readonly #left: LinearEnvelope;
  readonly #right: LinearEnvelope;
  readonly #rotation: number;
  readonly #top: LinearEnvelope;

  public constructor(
    elements: readonly InkElementV1[],
    rotation: number,
    entries?: readonly PaintBoundsEntry[],
  ) {
    const bottom: Line[] = [];
    const left: Line[] = [];
    const right: Line[] = [];
    const top: Line[] = [];
    this.#entries =
      entries ??
      elements.map((source) => {
        const element = selectionFrameElementAtRotation(source, rotation);
        const radius = paintRadius(element);
        return {
          id: source.id,
          path: contractBounds(calculateElementBounds(element), radius),
          radius,
        };
      });
    for (const { id, path, radius } of this.#entries) {
      left.push({ id, intercept: -radius, slope: path.minX });
      right.push({ id, intercept: radius, slope: path.maxX });
      top.push({ id, intercept: -radius, slope: path.minY });
      bottom.push({ id, intercept: radius, slope: path.maxY });
    }
    this.#bottom = new LinearEnvelope(bottom, "maximum");
    this.#left = new LinearEnvelope(left, "minimum");
    this.#right = new LinearEnvelope(right, "maximum");
    this.#rotation = rotation;
    this.#top = new LinearEnvelope(top, "minimum");
  }

  public without(ids: ReadonlySet<string>): SelectionScalePreviewFramePlan | null {
    if (![this.#bottom, this.#left, this.#right, this.#top].some((edge) => edge.includesAny(ids)))
      return this;
    const entries = this.#entries.filter(({ id }) => !ids.has(id));
    return entries.length === 0
      ? null
      : new SelectionScalePreviewFramePlan([], this.#rotation, entries);
  }

  public factorsForPointer(
    span: PointV1,
    movement: PointV1,
    minimum: ScaleFactors,
    uniform: boolean,
    initialFactors: ScaleFactors = { x: 1, y: 1 },
  ): ScaleFactors {
    // Pointer displacement changes the painted extent; constant-width margins never scale.
    const initial = this.#sizeAt(initialFactors);
    const target = {
      x: initial.x + Math.sign(span.x) * movement.x,
      y: initial.y + Math.sign(span.y) * movement.y,
    };
    if (uniform) {
      const projected = uniformScaleFactorFromPointers({ x: 0, y: 0 }, span, {
        x: span.x + movement.x,
        y: span.y + movement.y,
      });
      target.x = initial.x + Math.abs(span.x) * (projected - 1);
      target.y = initial.y + Math.abs(span.y) * (projected - 1);
      const weight = { x: Math.abs(span.x), y: Math.abs(span.y) };
      const factorsAt = (value: number): ScaleFactors => ({
        x: initialFactors.x === 0 ? Math.max(0, value - 1) : value,
        y: initialFactors.y === 0 ? Math.max(0, value - 1) : value,
      });
      const factor = solvePaintedScale(
        (value) => {
          const size = this.#sizeAt(factorsAt(value));
          return size.x * weight.x + size.y * weight.y;
        },
        target.x * weight.x + target.y * weight.y,
        Math.max(minimum.x, minimum.y),
      );
      return factorsAt(factor);
    }
    return {
      x:
        span.x === 0
          ? initialFactors.x
          : solvePaintedScale(
              (value) => this.#right.at(value) - this.#left.at(value),
              target.x,
              minimum.x,
            ),
      y:
        span.y === 0
          ? initialFactors.y
          : solvePaintedScale(
              (value) => this.#bottom.at(value) - this.#top.at(value),
              target.y,
              minimum.y,
            ),
    };
  }

  #sizeAt(factors: ScaleFactors): PointV1 {
    return {
      x: this.#right.at(factors.x) - this.#left.at(factors.x),
      y: this.#bottom.at(factors.y) - this.#top.at(factors.y),
    };
  }

  public resolve(
    anchor: PointV1,
    position: BoxAnchorV1,
    factors: ScaleFactors,
  ): { readonly delta: PointV1; readonly frame: OrientedSelectionFrame } {
    const bounds = this.boundsAt(anchor, factors);
    const frame = selectionFrameFromLocalBounds(bounds, this.#rotation);
    const actual = selectionFramePoint(frame, oppositeBoxAnchor(position));
    const delta = canonicalPoint({ x: anchor.x - actual.x, y: anchor.y - actual.y });
    return { delta, frame: translateSelectionFrame(frame, delta) };
  }
  public boundsAt(anchor: PointV1, factors: ScaleFactors): Bounds {
    const localAnchor = rotatePointClockwise(anchor, { x: 0, y: 0 }, -this.#rotation);
    return {
      maxX: localAnchor.x * (1 - factors.x) + this.#right.at(factors.x),
      maxY: localAnchor.y * (1 - factors.y) + this.#bottom.at(factors.y),
      minX: localAnchor.x * (1 - factors.x) + this.#left.at(factors.x),
      minY: localAnchor.y * (1 - factors.y) + this.#top.at(factors.y),
    };
  }
}

class LinearEnvelope {
  readonly #lines: readonly Line[];
  readonly #starts: readonly number[];
  readonly #sign: 1 | -1;

  public constructor(lines: readonly Line[], mode: "maximum" | "minimum") {
    if (lines.length === 0) throw new RangeError("A scale preview frame needs geometry.");
    this.#sign = mode === "maximum" ? 1 : -1;
    const normalized = lines.map(({ id, intercept, slope }) => ({
      id,
      intercept: intercept * this.#sign,
      slope: slope * this.#sign,
    }));
    const hull = maximumEnvelope(normalized);
    this.#lines = hull.lines;
    this.#starts = hull.starts;
  }

  public includesAny(ids: ReadonlySet<string>): boolean {
    return this.#lines.some(
      ({ id }, index) => ids.has(id) && (this.#starts[index + 1] ?? Infinity) > 0,
    );
  }

  public at(factor: number): number {
    let low = 0;
    let high = this.#starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#starts[middle]! <= factor) low = middle + 1;
      else high = middle;
    }
    const line = this.#lines[Math.max(0, low - 1)]!;
    return (line.slope * factor + line.intercept) * this.#sign;
  }
}

function maximumEnvelope(lines: readonly Line[]): {
  readonly lines: readonly Line[];
  readonly starts: readonly number[];
} {
  const sorted = [...lines].sort(
    (left, right) => left.slope - right.slope || right.intercept - left.intercept,
  );
  const hull: Line[] = [];
  const starts: number[] = [];
  for (const line of sorted) {
    if (hull[hull.length - 1]?.slope === line.slope) continue;
    let start = Number.NEGATIVE_INFINITY;
    while (hull.length > 0) {
      start = intersection(hull[hull.length - 1]!, line);
      if (start > starts[starts.length - 1]!) break;
      hull.pop();
      starts.pop();
    }
    hull.push(line);
    starts.push(start);
  }
  return { lines: hull, starts };
}

function contractBounds(bounds: Bounds, amount: number): Bounds {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    maxX: Math.max(centerX, bounds.maxX - amount),
    maxY: Math.max(centerY, bounds.maxY - amount),
    minX: Math.min(centerX, bounds.minX + amount),
    minY: Math.min(centerY, bounds.minY + amount),
  };
}

function intersection(left: Line, right: Line): number {
  return (left.intercept - right.intercept) / (right.slope - left.slope);
}

function paintRadius(element: InkElementV1): number {
  if (element.kind === "stroke" || element.kind === "straight-highlighter") {
    return effectiveStrokeWidth(element) / 2;
  }
  return element.style.outlineWidth / 2;
}

function solvePaintedScale(
  measure: (factor: number) => number,
  target: number,
  minimum: number,
): number {
  if (measure(minimum) >= target) return minimum;
  if (Math.abs(measure(1) - target) < 1e-9) return 1;
  if (measure(2) <= measure(1)) return 1;
  const candidate = (target - measure(0)) / (measure(1) - measure(0));
  if (candidate >= minimum && Math.abs(measure(candidate) - target) < 1e-9) return candidate;
  // Different selected elements can own the outer edge as the geometry grows.
  let low = minimum;
  let high = Math.max(1, minimum);
  for (let attempt = 0; attempt < 32 && measure(high) < target; attempt += 1) high *= 2;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const middle = (low + high) / 2;
    if (measure(middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
