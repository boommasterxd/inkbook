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
import type { ScaleFactors } from "./transforms";

interface Line {
  readonly intercept: number;
  readonly slope: number;
}

export class SelectionScalePreviewFramePlan {
  readonly #bottom: LinearEnvelope;
  readonly #left: LinearEnvelope;
  readonly #right: LinearEnvelope;
  readonly #rotation: number;
  readonly #top: LinearEnvelope;

  public constructor(elements: readonly InkElementV1[], rotation: number) {
    const bottom: Line[] = [];
    const left: Line[] = [];
    const right: Line[] = [];
    const top: Line[] = [];
    for (const source of elements) {
      const element = selectionFrameElementAtRotation(source, rotation);
      const radius = paintRadius(element);
      const path = contractBounds(calculateElementBounds(element), radius);
      left.push({ intercept: -radius, slope: path.minX });
      right.push({ intercept: radius, slope: path.maxX });
      top.push({ intercept: -radius, slope: path.minY });
      bottom.push({ intercept: radius, slope: path.maxY });
    }
    this.#bottom = new LinearEnvelope(bottom, "maximum");
    this.#left = new LinearEnvelope(left, "minimum");
    this.#right = new LinearEnvelope(right, "maximum");
    this.#rotation = rotation;
    this.#top = new LinearEnvelope(top, "minimum");
  }

  public resolve(
    anchor: PointV1,
    position: BoxAnchorV1,
    factors: ScaleFactors,
  ): { readonly delta: PointV1; readonly frame: OrientedSelectionFrame } {
    const localAnchor = rotatePointClockwise(anchor, { x: 0, y: 0 }, -this.#rotation);
    const bounds = {
      maxX: localAnchor.x * (1 - factors.x) + this.#right.at(factors.x),
      maxY: localAnchor.y * (1 - factors.y) + this.#bottom.at(factors.y),
      minX: localAnchor.x * (1 - factors.x) + this.#left.at(factors.x),
      minY: localAnchor.y * (1 - factors.y) + this.#top.at(factors.y),
    };
    const frame = selectionFrameFromLocalBounds(bounds, this.#rotation);
    const actual = selectionFramePoint(frame, oppositeBoxAnchor(position));
    const delta = canonicalPoint({ x: anchor.x - actual.x, y: anchor.y - actual.y });
    return { delta, frame: translateSelectionFrame(frame, delta) };
  }
}

class LinearEnvelope {
  readonly #lines: readonly Line[];
  readonly #starts: readonly number[];
  readonly #sign: 1 | -1;

  public constructor(lines: readonly Line[], mode: "maximum" | "minimum") {
    if (lines.length === 0) throw new RangeError("A scale preview frame needs geometry.");
    this.#sign = mode === "maximum" ? 1 : -1;
    const normalized = lines.map(({ intercept, slope }) => ({
      intercept: intercept * this.#sign,
      slope: slope * this.#sign,
    }));
    const hull = maximumEnvelope(normalized);
    this.#lines = hull.lines;
    this.#starts = hull.starts;
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
