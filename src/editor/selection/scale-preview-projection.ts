import { selectionCenterlineBounds } from "./centerline-bounds";
import {
  canonicalPoint,
  normalizeRotation,
  unionBounds,
  type Bounds,
} from "../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../domain/schema/public";

import { oppositeBoxAnchor } from "./handles";
import { SelectionScalePreviewFramePlan } from "./scale-preview-frame";
import {
  selectionFrameElementAtRotation,
  selectionFrameFromLocalBounds,
  selectionFramePoint,
  translateSelectionFrame,
  type OrientedSelectionFrame,
} from "./selection-frame";
import type { ScaleFactors } from "./transforms";

const MAXIMUM_PROJECTED_ELEMENTS = 256;

type MaterializeProjection = (element: InkElementV1, factors: ScaleFactors) => InkElementV1;

/** Measures bounded non-affine geometry without revisiting freehand samples. */
export class SelectionScalePreviewProjection {
  readonly #projected: readonly InkElementV1[];
  readonly #regular: SelectionScalePreviewFramePlan | null;
  readonly #rotation: number;

  public constructor(
    elements: readonly InkElementV1[],
    rotation: number,
    fallback: SelectionScalePreviewFramePlan,
  ) {
    const projected = elements.filter((element) => needsProjection(element, rotation));
    this.#projected = projected.length <= MAXIMUM_PROJECTED_ELEMENTS ? projected : [];
    this.#rotation = rotation;
    if (this.#projected.length === 0) {
      this.#regular = fallback;
      return;
    }
    const projectedIds = new Set(this.#projected.map(({ id }) => id));
    this.#regular = fallback.without(projectedIds);
  }

  public resolve(
    input: {
      readonly anchor: PointV1;
      readonly position: BoxAnchorV1;
      readonly factors: ScaleFactors;
    },
    materialize: MaterializeProjection,
  ): { readonly delta: PointV1; readonly frame: OrientedSelectionFrame } {
    if (this.#projected.length === 0) {
      return this.#regular!.resolve(input.anchor, input.position, input.factors);
    }
    let bounds: Bounds | null = this.#regular?.boundsAt(input.anchor, input.factors) ?? null;
    for (const source of this.#projected) {
      const element = materialize(source, input.factors);
      const current = selectionCenterlineBounds(
        selectionFrameElementAtRotation(element, this.#rotation),
      );
      bounds = bounds === null ? current : unionBounds(bounds, current);
    }
    if (bounds === null) throw new RangeError("A scale projection needs selected geometry.");
    const frame = selectionFrameFromLocalBounds(bounds, this.#rotation);
    const actual = selectionFramePoint(frame, oppositeBoxAnchor(input.position));
    const delta = canonicalPoint({ x: input.anchor.x - actual.x, y: input.anchor.y - actual.y });
    return { delta, frame: translateSelectionFrame(frame, delta) };
  }
}

function needsProjection(element: InkElementV1, rotation: number): boolean {
  if (element.kind === "arrow" || element.kind === "coordinate-system") return true;
  if (
    element.kind === "stroke" ||
    element.kind === "straight-highlighter" ||
    element.kind === "line"
  )
    return false;
  const relative = normalizeRotation(element.rotation - rotation);
  return Math.abs(relative - Math.round(relative / 90) * 90) > 0.001;
}
