import { selectionCenterlineBounds } from "./centerline-bounds";
import {
  canonicalPoint,
  defaultTableHeaderHeight,
  normalizeRotation,
  rotatePointClockwise,
  unionBounds,
  type Bounds,
} from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

import { recoverCollapsedScaleSource } from "./scale-recovery";
import { rotatedScaleTranslation } from "./scale-frame";
import { activeScaleAxes } from "./handle-session-geometry";
import type { SelectionHandleAction } from "./handle-types";
import { oppositeBoxAnchor } from "./handles";
import {
  createSelectionFrameAtRotation,
  selectionFrameElementAtRotation,
  selectionFramePoint,
  translateSelectionFrame,
  type OrientedSelectionFrame,
} from "./selection-frame";
import { SelectionScalePreviewProjection } from "./scale-preview-projection";
import { SelectionScalePreviewFramePlan } from "./scale-preview-frame";
import {
  moveSelection,
  moveSelectionTimeSliced,
  rotateSelection,
  scaleElement,
  type ScaleFactors,
  type TransformSliceScheduler,
} from "./transforms";

type ScaleAction = Extract<SelectionHandleAction, { kind: "scale" }>;

export class SelectionScaleGesture {
  readonly #action: ScaleAction;
  readonly #elements: readonly InkElementV1[];
  readonly #previewProjection: SelectionScalePreviewProjection;
  readonly #previewFramePlan: SelectionScalePreviewFramePlan;
  readonly #initialFactors: ScaleFactors;
  readonly #singleSource: InkElementV1 | null;
  readonly #startPointer: PointV1;
  #previewDelta: PointV1 = { x: 0, y: 0 };
  #previewFrame: OrientedSelectionFrame | null = null;

  public constructor(
    action: ScaleAction,
    elements: readonly InkElementV1[],
    startPointer: PointV1,
  ) {
    this.#action = action;
    this.#elements = elements;
    const recovered = elements.length === 1 ? recoverCollapsedScaleSource(elements[0]!) : null;
    this.#singleSource =
      recovered !== null && recovered.element !== elements[0] ? recovered.element : null;
    this.#initialFactors = recovered?.initial ?? { x: 1, y: 1 };
    const previewElements = recovered === null ? elements : [recovered.element];
    this.#previewFramePlan = new SelectionScalePreviewFramePlan(previewElements, action.rotation);
    this.#previewProjection = new SelectionScalePreviewProjection(
      previewElements,
      action.rotation,
      this.#previewFramePlan,
    );
    this.#startPointer = startPointer;
  }

  public factorsAt(pointer: PointV1, uniform: boolean): ScaleFactors {
    const anchor = this.#action.anchor;
    const start = rotatePointClockwise(this.#startPointer, anchor, -this.#action.rotation);
    const current = rotatePointClockwise(pointer, anchor, -this.#action.rotation);
    const axes = activeScaleAxes(this.#action.position);
    const span = { x: start.x - anchor.x, y: start.y - anchor.y };
    if (Math.abs(span.x) < 1e-9 && this.#initialFactors.x === 0)
      span.x = this.#action.position.includes("left") ? -1 : 1;
    if (Math.abs(span.y) < 1e-9 && this.#initialFactors.y === 0)
      span.y = this.#action.position.startsWith("top") ? -1 : 1;
    return this.#previewFramePlan.factorsForPointer(
      { x: axes.x ? span.x : 0, y: axes.y ? span.y : 0 },
      { x: axes.x ? current.x - start.x : 0, y: axes.y ? current.y - start.y : 0 },
      { x: 0, y: 0 },
      uniform,
      this.#initialFactors,
    );
  }

  public materialize(pointer: PointV1, uniform: boolean): InkElementV1[] {
    const factors = this.factorsAt(pointer, uniform);
    const replacements =
      this.#elements.length === 1
        ? [this.#scaleSingle(this.#elements[0]!, factors)]
        : this.#elements.map((element) => this.#scaleInFrame(element, factors));
    return this.stabilizeAnchor(replacements);
  }

  public materializeOne(
    element: InkElementV1,
    pointer: PointV1,
    uniform: boolean,
    factors: ScaleFactors | undefined,
  ): InkElementV1 {
    return this.#elements.length === 1 || factors === undefined
      ? this.#scaleSingle(element, factors ?? this.factorsAt(pointer, uniform))
      : this.#scaleInFrame(element, factors);
  }

  public previewFactors(
    pointer: PointV1,
    uniform: boolean,
    updateApproximateFrame: boolean,
  ): ScaleFactors {
    const factors = this.factorsAt(pointer, uniform);
    if (updateApproximateFrame) {
      const preview = this.#previewProjection.resolve(
        { anchor: this.#action.anchor, position: this.#action.position, factors },
        (element, values) => this.#scaleInFrame(element, values),
      );
      this.#previewDelta = preview.delta;
      this.#previewFrame = preview.frame;
    }
    return factors;
  }

  public get previewDelta(): PointV1 {
    return this.#previewDelta;
  }

  public get previewFrame(): OrientedSelectionFrame | null {
    return this.#previewFrame;
  }

  public stabilizeAnchor(elements: readonly InkElementV1[]): InkElementV1[] {
    const frame = createSelectionFrameAtRotation(elements, this.#action.rotation);
    if (frame === null) return [...elements];
    const actual = selectionFramePoint(frame, oppositeBoxAnchor(this.#action.position));
    this.#previewDelta = canonicalPoint({
      x: this.#action.anchor.x - actual.x,
      y: this.#action.anchor.y - actual.y,
    });
    this.#previewFrame = translateSelectionFrame(frame, this.#previewDelta);
    return moveSelection(elements, this.#previewDelta);
  }

  public async stabilizeAnchorTimeSliced(
    elements: readonly InkElementV1[],
    scheduler: TransformSliceScheduler,
  ): Promise<InkElementV1[] | null> {
    let bounds: Bounds | null = null;
    for (const element of elements) {
      if (scheduler.isCancelled?.() ?? false) return null;
      const local = selectionFrameElementAtRotation(element, this.#action.rotation);
      const current = selectionCenterlineBounds(local);
      bounds = bounds === null ? current : unionBounds(bounds, current);
      if (scheduler.shouldYield()) await scheduler.yieldControl();
    }
    if (bounds === null || (scheduler.isCancelled?.() ?? false)) return null;
    const actualLocal = boundsPoint(bounds, oppositeBoxAnchor(this.#action.position));
    const actual = rotatePointClockwise(actualLocal, { x: 0, y: 0 }, this.#action.rotation);
    this.#previewDelta = canonicalPoint({
      x: this.#action.anchor.x - actual.x,
      y: this.#action.anchor.y - actual.y,
    });
    return moveSelectionTimeSliced(elements, this.#previewDelta, scheduler);
  }

  #scaleInFrame(element: InkElementV1, factors: ScaleFactors): InkElementV1 {
    const aligned =
      this.#action.rotation === 0
        ? element
        : rotateSelection([element], this.#action.anchor, -this.#action.rotation)[0]!;
    const frameFactors = quarterTurnLocalFactors(aligned.rotation, factors);
    const scaled =
      frameFactors === null
        ? scaleElementInArbitraryFrame(aligned, this.#action.anchor, factors)
        : scaleQuarterTurnElement(aligned, this.#action.anchor, frameFactors, factors);
    return this.#action.rotation === 0
      ? scaled
      : rotateSelection([scaled], this.#action.anchor, this.#action.rotation)[0]!;
  }

  #scaleSingle(original: InkElementV1, factors: ScaleFactors): InkElementV1 {
    const element = this.#singleSource ?? original;
    const anchor = rotatePointClockwise(this.#action.anchor, element.pivot, -element.rotation);
    const scaled = scaleElement(
      element,
      anchor,
      factors,
      rotatedScaleTranslation(
        element.pivot,
        this.#action.anchor,
        anchor,
        element.rotation,
        factors,
      ),
    );
    return scaled.kind === "table" && original.kind === "table" && original.height === 0
      ? { ...scaled, headerHeight: defaultTableHeaderHeight(scaled.height) }
      : scaled;
  }
}

function scaleElementInArbitraryFrame(
  element: InkElementV1,
  anchor: PointV1,
  factors: ScaleFactors,
): InkElementV1 {
  const flattened = flattenPointGeometryRotation(element);
  return scaleElement(flattened, anchor, factors);
}

function flattenPointGeometryRotation(element: InkElementV1): InkElementV1 {
  if (element.rotation === 0) return element;
  const rotate = (point: PointV1): PointV1 =>
    canonicalPoint(rotatePointClockwise(point, element.pivot, element.rotation));
  if (element.kind === "stroke") {
    const points = element.points.slice();
    for (let index = 0; index < points.length; index += 3) {
      const rotated = rotate({
        x: points[index]! + (element.offset?.x ?? 0),
        y: points[index + 1]! + (element.offset?.y ?? 0),
      });
      points[index] = rotated.x;
      points[index + 1] = rotated.y;
    }
    const { offset: _offset, ...shape } = element;
    return { ...shape, points, rotation: 0 };
  }
  if (
    element.kind === "line" ||
    element.kind === "arrow" ||
    element.kind === "straight-highlighter"
  ) {
    return {
      ...element,
      bend: element.bend === null ? null : rotate(element.bend),
      end: rotate(element.end),
      rotation: 0,
      start: rotate(element.start),
    };
  }
  if (element.kind !== "coordinate-system") return element;
  const axes = element.axes.map(rotate);
  const origin = rotate(element.origin);
  return element.dimension === "2d"
    ? { ...element, axes: [axes[0]!, axes[1]!], origin, pivot: origin, rotation: 0 }
    : {
        ...element,
        axes: [axes[0]!, axes[1]!, axes[2]!],
        origin,
        pivot: origin,
        rotation: 0,
      };
}

function scaleQuarterTurnElement(
  element: InkElementV1,
  anchor: PointV1,
  localFactors: ScaleFactors,
  frameFactors: ScaleFactors,
): InkElementV1 {
  const targetPivot = canonicalPoint({
    x: anchor.x + (element.pivot.x - anchor.x) * frameFactors.x,
    y: anchor.y + (element.pivot.y - anchor.y) * frameFactors.y,
  });
  const scaled = scaleElement(element, element.pivot, localFactors);
  return moveSelection([scaled], {
    x: targetPivot.x - scaled.pivot.x,
    y: targetPivot.y - scaled.pivot.y,
  })[0]!;
}

function quarterTurnLocalFactors(rotation: number, factors: ScaleFactors): ScaleFactors | null {
  const normalized = normalizeRotation(rotation);
  const quarterTurns = Math.round(normalized / 90);
  if (Math.abs(normalized - quarterTurns * 90) > 0.001) return null;
  return quarterTurns % 2 === 0 ? factors : { x: factors.y, y: factors.x };
}

function boundsPoint(bounds: Bounds, position: ReturnType<typeof oppositeBoxAnchor>): PointV1 {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const points = {
    "bottom-center": { x: centerX, y: bounds.maxY },
    "bottom-left": { x: bounds.minX, y: bounds.maxY },
    "bottom-right": { x: bounds.maxX, y: bounds.maxY },
    "middle-left": { x: bounds.minX, y: centerY },
    "middle-right": { x: bounds.maxX, y: centerY },
    "top-center": { x: centerX, y: bounds.minY },
    "top-left": { x: bounds.minX, y: bounds.minY },
    "top-right": { x: bounds.maxX, y: bounds.minY },
  };
  return points[position];
}
