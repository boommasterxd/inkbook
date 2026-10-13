import { selectionCenterlineBounds } from "./centerline-bounds";
import {
  canonicalPoint,
  boundsFromPoints,
  rotatePointClockwise,
  unionBounds,
  type Bounds,
} from "../../domain/geometry/public";
import type {
  BoxAnchorV1,
  InkElementV1,
  PointV1,
  StrokeElementV1,
} from "../../domain/schema/public";

import { oppositeBoxAnchor } from "./handles";
import {
  selectionFrameElementAtRotation,
  selectionFrameFromLocalBounds,
  selectionFramePoint,
  translateSelectionFrame,
  type OrientedSelectionFrame,
} from "./selection-frame";
import { uniformScaleFactorFromPointers, type ScaleFactors } from "./transforms";

interface CenterlineBoundsEntry {
  readonly id: string;
  readonly bounds: Bounds;
}

export class SelectionScalePreviewFramePlan {
  readonly #entries: readonly CenterlineBoundsEntry[];
  readonly #bounds: Bounds;
  readonly #rotation: number;

  public static fromSingleStrokeFrame(
    element: StrokeElementV1,
    frame: OrientedSelectionFrame,
  ): SelectionScalePreviewFramePlan {
    const aligned = selectionFrameElementAtRotation(element, frame.rotation) as StrokeElementV1;
    const delta = {
      x: (aligned.offset?.x ?? 0) - (element.offset?.x ?? 0),
      y: (aligned.offset?.y ?? 0) - (element.offset?.y ?? 0),
    };
    // Match the existing pivot/offset canonicalization when aligning sample geometry.
    const bounds = boundsFromPoints(
      frame.points.map((point) => {
        const local = rotatePointClockwise(point, element.pivot, -frame.rotation);
        return { x: local.x + delta.x, y: local.y + delta.y };
      }),
    );
    const [topLeft, topRight, , bottomLeft] = frame.points;
    // Inverse rotation must not turn an exactly collapsed edge into a positive extent.
    if (topLeft.x === topRight.x && topLeft.y === topRight.y) bounds.maxX = bounds.minX;
    if (topLeft.x === bottomLeft.x && topLeft.y === bottomLeft.y) bounds.maxY = bounds.minY;
    return new SelectionScalePreviewFramePlan([], frame.rotation, [{ id: element.id, bounds }]);
  }

  public constructor(
    elements: readonly InkElementV1[],
    rotation: number,
    entries?: readonly CenterlineBoundsEntry[],
  ) {
    this.#entries =
      entries ??
      elements.map((source) => ({
        id: source.id,
        bounds: selectionCenterlineBounds(selectionFrameElementAtRotation(source, rotation)),
      }));
    if (this.#entries.length === 0) throw new RangeError("A scale preview frame needs geometry.");
    this.#bounds = this.#entries.reduce(
      (bounds, entry) => unionBounds(bounds, entry.bounds),
      this.#entries[0]!.bounds,
    );
    this.#rotation = rotation;
  }

  public without(ids: ReadonlySet<string>): SelectionScalePreviewFramePlan | null {
    const entries = this.#entries.filter(({ id }) => !ids.has(id));
    if (entries.length === this.#entries.length) return this;
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
    // The transform frame follows centerline geometry, independent of paint width.
    const size = {
      x: this.#bounds.maxX - this.#bounds.minX,
      y: this.#bounds.maxY - this.#bounds.minY,
    };
    const initial = { x: size.x * initialFactors.x, y: size.y * initialFactors.y };
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
      const weighted = { x: size.x * weight.x, y: size.y * weight.y };
      const recovered =
        (initialFactors.x === 0 ? weighted.x : 0) + (initialFactors.y === 0 ? weighted.y : 0);
      const regular =
        (initialFactors.x === 0 ? 0 : weighted.x) + (initialFactors.y === 0 ? 0 : weighted.y);
      const factor = solveScale(
        regular,
        recovered,
        target.x * weight.x + target.y * weight.y,
        Math.max(minimum.x, minimum.y),
      );
      return factorsAt(factor);
    }
    return {
      x: span.x === 0 ? initialFactors.x : solveScale(size.x, 0, target.x, minimum.x),
      y: span.y === 0 ? initialFactors.y : solveScale(size.y, 0, target.y, minimum.y),
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
      maxX: localAnchor.x * (1 - factors.x) + this.#bounds.maxX * factors.x,
      maxY: localAnchor.y * (1 - factors.y) + this.#bounds.maxY * factors.y,
      minX: localAnchor.x * (1 - factors.x) + this.#bounds.minX * factors.x,
      minY: localAnchor.y * (1 - factors.y) + this.#bounds.minY * factors.y,
    };
  }
}

/** Inverts regular * factor + recovered * max(0, factor - 1). */
function solveScale(regular: number, recovered: number, target: number, minimum: number): number {
  if (regular * minimum + recovered * Math.max(0, minimum - 1) >= target) return minimum;
  if (Math.abs(regular - target) < 1e-9) return 1;
  if (2 * regular + recovered <= regular) return 1;
  const factor =
    recovered === 0 || target <= regular
      ? target / regular
      : 1 + (target - regular) / (regular + recovered);
  return Math.max(minimum, factor);
}
