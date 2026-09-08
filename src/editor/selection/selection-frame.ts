import {
  calculateElementBounds,
  canonicalPoint,
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
import { rotateSelection } from "./transforms";

export type OrientedSelectionFrame = SelectionPreviewFrame;

export interface SelectionFrameHistoryEffect {
  apply(): void;
  revert(): void;
}

export class SelectionFrameSession {
  readonly #onChanged: () => void;
  #frame: OrientedSelectionFrame | null = null;
  #revision = 0;

  public constructor(onChanged: () => void = () => undefined) {
    this.#onChanged = onChanged;
  }

  public current(selected: readonly SelectedElementGeometry[]): OrientedSelectionFrame | null {
    if (selected.length < 2) return null;
    this.#frame ??= createSelectionFrame(selected);
    return this.#frame;
  }

  public reset(): void {
    this.#revision += 1;
    this.#frame = null;
  }

  public transition(
    frame: OrientedSelectionFrame | null,
    transform: SelectionPreviewTransform | null,
  ): SelectionFrameHistoryEffect | undefined {
    if (frame === null || transform === null) return undefined;
    const revision = this.#revision;
    const replacement = transformSelectionFrame(frame, transform);
    return {
      apply: () => this.#replaceAtRevision(revision, replacement),
      revert: () => this.#replaceAtRevision(revision, frame),
    };
  }

  public rebase(
    frame: OrientedSelectionFrame | null,
    elements: readonly InkElementV1[],
  ): SelectionFrameHistoryEffect | undefined {
    if (frame === null || elements.length < 2) return undefined;
    const replacement = createSelectionFrameAtRotation(elements, frame.rotation);
    if (replacement === null) return undefined;
    const revision = this.#revision;
    return {
      apply: () => this.#replaceAtRevision(revision, replacement),
      revert: () => this.#replaceAtRevision(revision, frame),
    };
  }

  #replaceAtRevision(revision: number, frame: OrientedSelectionFrame): void {
    if (revision !== this.#revision) return;
    this.#frame = frame;
    this.#onChanged();
  }
}

export function createSelectionFrameAtRotation(
  elements: readonly InkElementV1[],
  rotation: number,
): OrientedSelectionFrame | null {
  let bounds: Bounds | null = null;
  for (const source of elements) {
    const element = selectionFrameElementAtRotation(source, rotation);
    const current = calculateElementBounds(element);
    bounds = bounds === null ? current : unionBounds(bounds, current);
  }
  if (bounds === null) return null;
  return selectionFrameFromLocalBounds(bounds, rotation);
}

export function selectionFrameFromLocalBounds(
  bounds: Bounds,
  rotation: number,
): OrientedSelectionFrame {
  return {
    points: framePoints(bounds).map((point) =>
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
  let bounds: Bounds | null = null;
  for (const item of selected) {
    bounds = bounds === null ? { ...item.bounds } : unionBounds(bounds, item.bounds);
  }
  if (bounds === null) return null;
  return {
    points: framePoints(bounds),
    rotation: 0,
  };
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

function framePoints(bounds: Bounds): OrientedSelectionFrame["points"] {
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
