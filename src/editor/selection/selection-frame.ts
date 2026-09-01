import {
  calculateElementBounds,
  canonicalPoint,
  normalizeRotation,
  rotatePointClockwise,
  unionBounds,
  type Bounds,
} from "../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../domain/schema/public";

import type { SelectedElementGeometry, SelectionPreviewTransform } from "./handle-types";
import { rotateSelection } from "./transforms";

export interface OrientedSelectionFrame {
  readonly points: readonly [PointV1, PointV1, PointV1, PointV1];
  readonly rotation: number;
}

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
  const rigid = elements.map(withoutExternalConnections);
  const local = rotation === 0 ? rigid : rotateSelection(rigid, { x: 0, y: 0 }, -rotation);
  let bounds: Bounds | null = null;
  for (const element of local) {
    const current = calculateElementBounds(element);
    bounds = bounds === null ? current : unionBounds(bounds, current);
  }
  if (bounds === null) return null;
  const points = framePoints(bounds);
  return {
    points: points.map((point) =>
      rotatePointClockwise(point, { x: 0, y: 0 }, rotation),
    ) as unknown as OrientedSelectionFrame["points"],
    rotation,
  };
}

function withoutExternalConnections(element: InkElementV1): InkElementV1 {
  return element.kind === "line" || element.kind === "arrow"
    ? { ...element, endConnection: null, startConnection: null }
    : element;
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
  return canonicalPoint(rotatePointClockwise(scaled, transform.anchor, transform.rotation));
}
