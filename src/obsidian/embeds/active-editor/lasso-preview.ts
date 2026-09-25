import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { GesturePreview } from "../../../editor/gestures/public";
import {
  createRectangleSelectionArea,
  LassoSelectionSession,
  selectBySelectionAreaCandidatesSteps,
  type SelectionAreaCandidate,
  type SelectionArea,
} from "../../../editor/selection/public";

import type { CoalescedCreationSample, CoalescedFrameSampleMode } from "./coalesced-input";
import { SelectionQueryWork } from "./selection-query-work";
import type { SelectionPreviewOptions } from "./selection-preview-contracts";

export class LassoPreview implements GesturePreview {
  readonly #options: SelectionPreviewOptions;
  readonly #lasso: LassoSelectionSession;
  readonly #selectionDefaults: NonNullable<SelectionPreviewOptions["selectionDefaults"]>;
  readonly #startSelection: ReadonlySet<string>;
  #current: PointV1;
  #finished = false;
  #work: SelectionQueryWork | undefined;

  public get frameSampleMode(): CoalescedFrameSampleMode {
    return this.#selectionDefaults.area === "lasso" ? "preserve" : "latest";
  }

  public constructor(options: SelectionPreviewOptions) {
    this.#options = options;
    this.#startSelection = options.selection();
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
    this.#options.renderer.setOverlayPath(null);
    if (area === null) {
      const next =
        this.#options.start.additive || previous.size === 0 ? previous : new Set<string>();
      if (next !== previous) this.#options.setSelection(next);
      return next !== previous;
    }
    this.#work = new SelectionQueryWork(
      this.#options,
      selectBySelectionAreaCandidatesSteps(
        previous,
        area,
        this.#selectionDefaults.inclusion,
        this.#options.start.additive,
        selectionCandidates(this.#options, area),
      ),
    );
    return this.#work.start();
  }

  public revert(): void {
    this.#work?.cancel();
    if (this.#finished) return;
    this.#finished = true;
    this.#options.renderer.setOverlayPath(null);
  }

  public update(pointer: SelectionPreviewOptions["start"]["pointer"]): void {
    this.updateSamples([{ ...pointer, time: 0 }]);
  }

  public updateSamples(samples: readonly CoalescedCreationSample[]): void {
    this.#assertActive();
    if (samples.length === 0) return;
    this.#current = samples[samples.length - 1]!;
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

/** Retains only one bounded spatial-query batch and releases it when work is abandoned. */
function* selectionCandidates(
  options: SelectionPreviewOptions,
  area: SelectionArea,
): Generator<SelectionAreaCandidate | undefined, boolean> {
  const query = options.sceneStore.beginQuery(area.bounds);
  try {
    while (true) {
      const step = query.advance(64);
      yield undefined;
      if (step.stale) return false;
      for (const id of step.ids) {
        const record = options.store.get(id);
        if (record !== undefined) {
          yield {
            id,
            bounds: record.bounds,
            element: record.element as InkElementV1,
            preparedPressure: options.sceneStore.pressureGeometry(id, record.geometryVersion),
          };
        }
      }
      if (step.done) return true;
    }
  } finally {
    query.cancel();
  }
}
