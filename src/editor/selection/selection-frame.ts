import { selectionCenterlineBounds } from "./centerline-bounds";
import { isStoredStroke } from "../../domain/elements/stroke-replacement-proof";
import { sameLocalSelectionShape } from "../../domain/store/records/prepared-stroke-center-cache";
import {
  canonicalPoint,
  calculateElementBoundsSteps,
  normalizeRotation,
  rotatePointClockwise,
  unionBounds,
  type Bounds,
} from "../../domain/geometry/public";
import type { BoxAnchorV1, InkElementV1, PointV1 } from "../../domain/schema/public";

import type {
  SelectedElementGeometry,
  SelectionPreviewFrame,
  SelectionPreviewTransform,
} from "./handle-types";
import { rotateSelection, type TransformSliceScheduler } from "./transform/transforms";

export type OrientedSelectionFrame = SelectionPreviewFrame;

export interface SelectionFrameHistoryEffect {
  apply(): void;
  revert(): void;
}

export class SelectionFrameSession {
  readonly #onChanged: () => void;
  #frame: OrientedSelectionFrame | null = null;
  #singleStroke: { readonly element: InkElementV1; readonly frame: OrientedSelectionFrame } | null =
    null;
  #revision = 0;

  public constructor(onChanged: () => void = () => undefined) {
    this.#onChanged = onChanged;
  }

  public current(selected: readonly SelectedElementGeometry[]): OrientedSelectionFrame | null {
    if (selected.length < 2) return this.#currentSingleStroke(selected);
    this.#frame ??= createSelectionFrame(selected);
    return this.#frame;
  }

  public async currentTimeSliced(
    selected: readonly SelectedElementGeometry[],
    scheduler: TransformSliceScheduler,
  ): Promise<OrientedSelectionFrame | null> {
    if (selected.length < 2) return this.#currentSingleStrokeTimeSliced(selected, scheduler);
    if (this.#frame !== null) return this.#frame;
    const revision = this.#revision;
    const frame = await prepareFrame(createSelectionFrameSteps(selected), scheduler);
    if (revision !== this.#revision || scheduler.isCancelled?.()) return null;
    this.#frame = frame;
    return frame;
  }

  public reset(): void {
    this.#revision += 1;
    this.#frame = null;
    this.#singleStroke = null;
  }

  public transition(
    frame: OrientedSelectionFrame | null,
    transform: SelectionPreviewTransform | null,
  ): SelectionFrameHistoryEffect | undefined {
    if (frame === null || transform === null) return undefined;
    const revision = this.#revision;
    const replacement = transformSelectionFrame(frame, transform);
    return this.#rebaseEffect(frame, replacement, revision);
  }

  public rebase(
    frame: OrientedSelectionFrame | null,
    elements: readonly InkElementV1[],
  ): SelectionFrameHistoryEffect | undefined {
    if (frame === null || elements.length < 2) return undefined;
    const replacement = createSelectionFrameAtRotation(elements, frame.rotation);
    if (replacement === null) return undefined;
    return this.#rebaseEffect(frame, replacement, this.#revision);
  }

  public async rebaseTimeSliced(
    frame: OrientedSelectionFrame | null,
    elements: readonly InkElementV1[],
    scheduler: TransformSliceScheduler,
  ): Promise<SelectionFrameHistoryEffect | undefined> {
    if (frame === null || elements.length < 2) return undefined;
    const revision = this.#revision;
    const replacement = await prepareFrame(
      createSelectionFrameAtRotationSteps(elements, frame.rotation),
      scheduler,
    );
    if (replacement === null || revision !== this.#revision || scheduler.isCancelled?.())
      return undefined;
    return this.#rebaseEffect(frame, replacement, revision);
  }

  #rebaseEffect(
    frame: OrientedSelectionFrame,
    replacement: OrientedSelectionFrame,
    revision: number,
  ): SelectionFrameHistoryEffect {
    const session = new WeakRef(this);
    const replace = (next: OrientedSelectionFrame) => {
      const current = session.deref();
      if (current !== undefined) current.#replaceAtRevision(revision, next);
    };
    return {
      apply: () => replace(replacement),
      revert: () => replace(frame),
    };
  }

  #replaceAtRevision(revision: number, frame: OrientedSelectionFrame): void {
    if (revision !== this.#revision) return;
    this.#frame = frame;
    this.#onChanged();
  }

  #currentSingleStroke(
    selected: readonly SelectedElementGeometry[],
  ): OrientedSelectionFrame | null {
    const item = selected[0];
    if (item?.element.kind !== "stroke") {
      this.#singleStroke = null;
      return null;
    }
    const cached = this.#singleStroke;
    if (cached !== null && sameSingleStrokeFrame(cached.element, item.element)) return cached.frame;
    const frame = createSingleStrokeSelectionFrame(item);
    if (isStoredStroke(item.element)) this.#singleStroke = { element: item.element, frame };
    return frame;
  }

  async #currentSingleStrokeTimeSliced(
    selected: readonly SelectedElementGeometry[],
    scheduler: TransformSliceScheduler,
  ): Promise<OrientedSelectionFrame | null> {
    if (scheduler.isCancelled?.()) return null;
    const item = selected[0];
    if (item?.element.kind !== "stroke") return this.#currentSingleStroke(selected);
    const cached = this.#singleStroke;
    if (cached !== null && sameSingleStrokeFrame(cached.element, item.element)) return cached.frame;
    const revision = this.#revision;
    const frame = await prepareFrame(createSingleStrokeFrameSteps(item), scheduler);
    if (frame === null || revision !== this.#revision || scheduler.isCancelled?.()) return null;
    if (isStoredStroke(item.element)) this.#singleStroke = { element: item.element, frame };
    return frame;
  }
}

function sameSingleStrokeFrame(first: InkElementV1, second: InkElementV1): boolean {
  if (first === second) return true;
  return (
    first.kind === "stroke" &&
    second.kind === "stroke" &&
    isStoredStroke(second) &&
    sameLocalSelectionShape(first, second) &&
    first.tool === second.tool &&
    first.offset?.x === second.offset?.x &&
    first.offset?.y === second.offset?.y
  );
}

/** One local bound calculation supplies both the outline and every single-stroke handle. */
export function createSingleStrokeSelectionFrame(
  selected: SelectedElementGeometry,
): OrientedSelectionFrame {
  return completeFrame(createSingleStrokeFrameSteps(selected))!;
}

function* createSingleStrokeFrameSteps(
  selected: SelectedElementGeometry,
): Generator<void, OrientedSelectionFrame> {
  const element = selected.element;
  const painted =
    element.rotation === 0
      ? selected.bounds
      : yield* calculateElementBoundsSteps({ ...element, rotation: 0 });
  const bounds = selectionCenterlineBounds({ ...element, rotation: 0 }, painted);
  return {
    points: selectionFrameBoundsPoints(bounds).map((point) =>
      rotatePointClockwise(point, element.pivot, element.rotation),
    ) as unknown as OrientedSelectionFrame["points"],
    rotation: element.rotation,
  };
}

export function createSelectionFrameAtRotation(
  elements: readonly InkElementV1[],
  rotation: number,
): OrientedSelectionFrame | null {
  return completeFrame(createSelectionFrameAtRotationSteps(elements, rotation));
}

function* createSelectionFrameAtRotationSteps(
  elements: readonly InkElementV1[],
  rotation: number,
): Generator<void, OrientedSelectionFrame | null> {
  let bounds: Bounds | null = null;
  for (const source of elements) {
    const element = selectionFrameElementAtRotation(source, rotation);
    const painted = yield* calculateElementBoundsSteps(element);
    const current = selectionCenterlineBounds(element, painted);
    bounds = bounds === null ? current : unionBounds(bounds, current);
    yield;
  }
  if (bounds === null) return null;
  return selectionFrameFromLocalBounds(bounds, rotation);
}

export function selectionFrameFromLocalBounds(
  bounds: Bounds,
  rotation: number,
): OrientedSelectionFrame {
  return {
    points: selectionFrameBoundsPoints(bounds).map((point) =>
      rotatePointClockwise(point, { x: 0, y: 0 }, rotation),
    ) as unknown as OrientedSelectionFrame["points"],
    rotation,
  };
}

export function translateSelectionFrame(
  frame: OrientedSelectionFrame,
  delta: PointV1,
): OrientedSelectionFrame {
  return {
    points: frame.points.map((point) => ({
      x: point.x + delta.x,
      y: point.y + delta.y,
    })) as unknown as OrientedSelectionFrame["points"],
    rotation: frame.rotation,
  };
}

export function selectionFrameElementAtRotation(
  element: InkElementV1,
  rotation: number,
): InkElementV1 {
  const rigid =
    element.kind === "line" || element.kind === "arrow"
      ? { ...element, endConnection: null, startConnection: null }
      : element;
  return rotation === 0 ? rigid : rotateSelection([rigid], { x: 0, y: 0 }, -rotation)[0]!;
}

export function createSelectionFrame(
  selected: readonly SelectedElementGeometry[],
): OrientedSelectionFrame | null {
  return completeFrame(createSelectionFrameSteps(selected));
}

function* createSelectionFrameSteps(
  selected: readonly SelectedElementGeometry[],
): Generator<void, OrientedSelectionFrame | null> {
  let bounds: Bounds | null = null;
  for (const item of selected) {
    const current = selectionCenterlineBounds(item.element, item.bounds);
    bounds = bounds === null ? current : unionBounds(bounds, current);
    yield;
  }
  if (bounds === null) return null;
  return {
    points: selectionFrameBoundsPoints(bounds),
    rotation: 0,
  };
}

function completeFrame(
  steps: Generator<void, OrientedSelectionFrame | null>,
): OrientedSelectionFrame | null {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

async function prepareFrame(
  steps: Generator<void, OrientedSelectionFrame | null>,
  scheduler: TransformSliceScheduler,
): Promise<OrientedSelectionFrame | null> {
  while (!scheduler.isCancelled?.()) {
    if (scheduler.shouldYield()) {
      await scheduler.yieldControl();
      if (scheduler.isCancelled?.()) return null;
    }
    const step = steps.next();
    if (step.done) return step.value;
  }
  return null;
}

export function selectionFramePoint(frame: OrientedSelectionFrame, position: BoxAnchorV1): PointV1 {
  const [topLeft, topRight, bottomRight, bottomLeft] = frame.points;
  const midpoint = (start: PointV1, end: PointV1): PointV1 => ({
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  });
  const points: Readonly<Record<BoxAnchorV1, PointV1>> = {
    "bottom-center": midpoint(bottomRight, bottomLeft),
    "bottom-left": bottomLeft,
    "bottom-right": bottomRight,
    "middle-left": midpoint(bottomLeft, topLeft),
    "middle-right": midpoint(topRight, bottomRight),
    "top-center": midpoint(topLeft, topRight),
    "top-left": topLeft,
    "top-right": topRight,
  };
  return points[position];
}

export function selectionFrameBoundsPoints(bounds: Bounds): OrientedSelectionFrame["points"] {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
}

export function transformSelectionFrame(
  frame: OrientedSelectionFrame,
  transform: SelectionPreviewTransform,
): OrientedSelectionFrame {
  return {
    points: frame.points.map((point) =>
      transformSelectionPoint(point, transform),
    ) as unknown as OrientedSelectionFrame["points"],
    rotation:
      transform.kind === "rotate"
        ? normalizeRotation(frame.rotation + transform.degrees)
        : frame.rotation,
  };
}

export function transformSelectionPoint(
  point: PointV1,
  transform: SelectionPreviewTransform,
): PointV1 {
  if (transform.kind === "translate") {
    return canonicalPoint({ x: point.x + transform.delta.x, y: point.y + transform.delta.y });
  }
  if (transform.kind === "rotate") {
    return canonicalPoint(rotatePointClockwise(point, transform.center, transform.degrees));
  }
  const local = rotatePointClockwise(point, transform.anchor, -transform.rotation);
  const scaled = {
    x: transform.anchor.x + (local.x - transform.anchor.x) * transform.factors.x,
    y: transform.anchor.y + (local.y - transform.anchor.y) * transform.factors.y,
  };
  const world = rotatePointClockwise(scaled, transform.anchor, transform.rotation);
  return canonicalPoint({ x: world.x + transform.delta.x, y: world.y + transform.delta.y });
}
