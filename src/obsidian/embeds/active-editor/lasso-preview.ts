import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { GesturePreview } from "../../../editor/gestures/public";
import {
  createRectangleSelectionArea,
  LassoSelectionSession,
  selectBySelectionAreaQuery,
  type SelectionArea,
} from "../../../editor/selection/public";

import type { CoalescedCreationSample } from "./coalesced-input";
import type { SelectionPreviewOptions } from "./selection-preview-contracts";

export class LassoPreview implements GesturePreview {
  readonly #options: SelectionPreviewOptions;
  readonly #lasso: LassoSelectionSession;
  readonly #selectionDefaults: NonNullable<SelectionPreviewOptions["selectionDefaults"]>;
  readonly #startSelection: ReadonlySet<string>;
  #current: PointV1;
  #finished = false;

  public constructor(options: SelectionPreviewOptions) {
    this.#options = options;
    this.#startSelection = new Set(options.selection());
    this.#selectionDefaults = options.selectionDefaults ?? {
      area: "rectangle",
      inclusion: "touched",
    };
    this.#current = options.start.pointer;
    this.#lasso = new LassoSelectionSession(options.start.pointer, this.#selectionZoom());
    this.#render();
  }

  public commit(): boolean {
    this.#assertActive();
    this.#finished = true;
    const previous = this.#startSelection;
    const area = this.#selectionArea();
    const next =
      area === null
        ? this.#options.start.additive || previous.size === 0
          ? previous
          : new Set<string>()
        : selectBySelectionAreaQuery(
            previous,
            area,
            this.#selectionDefaults.inclusion,
            this.#options.start.additive,
            (bounds, sink) =>
              this.#options.sceneStore.query(bounds, {
                add: (id) => {
                  const record = this.#options.store.get(id);
                  if (record !== undefined) {
                    sink.add(id, record.bounds, record.element as InkElementV1);
                  }
                },
              }),
          );
    this.#options.renderer.setOverlayPath(null);
    if (next !== previous) this.#options.setSelection(next);
    return next !== previous;
  }

  public revert(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#options.renderer.setOverlayPath(null);
  }

  public update(pointer: SelectionPreviewOptions["start"]["pointer"]): void {
    this.updateSamples([{ ...pointer, time: 0 }]);
  }

  public updateSamples(samples: readonly CoalescedCreationSample[]): void {
    this.#assertActive();
    const current = samples[samples.length - 1];
    if (current === undefined) return;
    this.#current = current;
    if (this.#selectionDefaults.area === "lasso") this.#lasso.appendBatch(samples);
    this.#render();
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed lasso preview cannot be updated.");
  }

  #render(): void {
    const points =
      this.#selectionDefaults.area === "rectangle"
        ? createRectangleSelectionArea(this.#options.start.pointer, this.#current).points
        : this.#lasso.points;
    this.#options.renderer.setOverlayPath(screenSelectionPath(points, this.#options.pageToScreen));
  }

  #selectionArea(): SelectionArea | null {
    if (this.#selectionDefaults.area === "rectangle") {
      return createRectangleSelectionArea(this.#options.start.pointer, this.#current);
    }
    return this.#lasso.selectionArea();
  }

  #selectionZoom(): number {
    const zoom = this.#options.zoom?.();
    return zoom !== undefined && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  }
}

function screenSelectionPath(
  points: readonly PointV1[],
  pageToScreen: (point: PointV1) => PointV1,
): string {
  const firstPoint = points[0];
  if (firstPoint === undefined) return "";
  const first = pageToScreen(firstPoint);
  const path = [`M ${String(first.x)} ${String(first.y)}`];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const screen = pageToScreen(point);
    path.push(`L ${String(screen.x)} ${String(screen.y)}`);
  }
  if (points.length >= 3) path.push("Z");
  return path.join(" ");
}
