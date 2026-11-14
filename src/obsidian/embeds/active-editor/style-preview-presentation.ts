import { calculateElementBoundsSteps } from "../../../domain/geometry/public";
import type { PointV1 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import {
  createSelectionFrameAtRotationTimeSliced,
  selectionOverlayGeometry,
  type SelectedElementGeometry,
  type SelectionFrameSession,
} from "../../../editor/selection/public";
import type { TransformSliceScheduler } from "../../../editor/selection/transform/transforms";
import type { PreparedStyleReplacement } from "./prepared-style-replacement";
import {
  SelectionHandlePresentation,
  type HandleInteractionRenderer,
} from "./previews/handle-presentation";

export interface StyleSliderPreviewOptions {
  readonly renderer: HandleInteractionRenderer;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly zoom: () => number;
  readonly workScheduler: WorkScheduler;
  readonly layout?: {
    begin(): void;
    updateBottom(maximumBottom: number): void;
    finish(committed: boolean): void;
  };
}

/** Shares the ordinary handle projection and scene preview ownership during a style drag. */
export class StylePreviewPresentation {
  readonly #handles: SelectionHandlePresentation;
  #version = 0;
  #layoutActive = false;
  public constructor(
    private readonly options: StyleSliderPreviewOptions,
    private readonly frames: SelectionFrameSession | undefined,
  ) {
    this.#handles = new SelectionHandlePresentation(
      options.renderer,
      options.pageToScreen,
      options.zoom,
    );
  }

  public async render(prepared: PreparedStyleReplacement, signal: AbortSignal): Promise<void> {
    const scheduler: TransformSliceScheduler = {
      isCancelled: () => signal.aborted,
      shouldYield: () => this.options.workScheduler.shouldYield(),
      yieldControl: () =>
        this.options.workScheduler.checkpoint(signal, "input") ?? Promise.resolve(),
    };
    const geometry: SelectedElementGeometry[] = [];
    let maximumBottom = -Infinity;
    for (const [index, element] of prepared.replacements.entries()) {
      signal.throwIfAborted();
      let bounds = prepared.selected[index]!.bounds;
      if (element !== prepared.previous[index]) {
        const steps = calculateElementBoundsSteps(element);
        let step = steps.next();
        while (!step.done) {
          if (scheduler.shouldYield()) await scheduler.yieldControl();
          signal.throwIfAborted();
          step = steps.next();
        }
        bounds = step.value;
      }
      geometry.push({ element, bounds });
      maximumBottom = Math.max(maximumBottom, bounds.maxY);
      if (scheduler.shouldYield()) await scheduler.yieldControl();
    }
    const previousFrame = await this.frames?.currentTimeSliced(prepared.selected, scheduler);
    const frame =
      geometry.length > 1
        ? await createSelectionFrameAtRotationTimeSliced(
            prepared.replacements,
            previousFrame?.rotation ?? 0,
            scheduler,
          )
        : null;
    signal.throwIfAborted();
    if (this.options.layout && Number.isFinite(maximumBottom)) {
      if (!this.#layoutActive) {
        this.options.layout.begin();
        this.#layoutActive = true;
      }
      this.options.layout.updateBottom(maximumBottom);
    }
    this.options.renderer.setElementPreviews(prepared.replacements, ++this.#version);
    this.#handles.renderGeometry(
      geometry,
      selectionOverlayGeometry(geometry, this.options.zoom(), null, frame),
    );
    this.options.renderer.flushPointerFeedbackFrame();
  }

  public clear(committed: boolean): void {
    this.#handles.clearPreviews();
    if (this.#layoutActive) this.options.layout?.finish(committed);
    this.#layoutActive = false;
  }
}
