import type { InkElementV1, PointV1, TextElementV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { SelectionHandlePreview, SelectionHandleSessionOptions } from "../handle-types";
import { alignReflowedText, type TextReflow } from "./text-reflow-session";
import type { SelectionScaleGesture } from "./selection-scale";
import { scaleElement, type ScaleFactors, type TransformSliceScheduler } from "./transforms";

interface LiveTextScale {
  readonly source: TextElementV2;
  readonly scale: SelectionScaleGesture;
  readonly scheduler: WorkScheduler;
  readonly onReady: () => void;
  readonly anchor: PointV1;
  readonly rotation: number;
}

interface ScaleRequest {
  readonly pointer: PointV1;
  readonly uniform: boolean;
  readonly factors: ScaleFactors;
}

/** Keeps immediate affine feedback until one current native layout can replace it atomically. */
export class TextScaleCommitReflow {
  readonly #reflow: TextReflow | undefined;
  readonly #live: LiveTextScale | undefined;
  #abort: AbortController | undefined;
  #operation: Promise<void> | undefined;
  #requested: ScaleRequest | undefined;
  #prepared: { readonly request: ScaleRequest; readonly element: TextElementV2 } | undefined;
  #failure: Error | undefined;

  public constructor(
    options: SelectionHandleSessionOptions,
    scale: SelectionScaleGesture | undefined,
    onReady: () => void,
  ) {
    this.#reflow = options.reflowText;
    const source = options.elements.length === 1 ? options.elements[0] : undefined;
    const scheduler = options.snap?.scheduler;
    if (
      source?.kind === "text" &&
      options.action.kind === "scale" &&
      !options.action.position.startsWith("middle-") &&
      !options.action.position.endsWith("-center") &&
      this.#reflow !== undefined &&
      scale !== undefined &&
      scheduler !== undefined
    )
      this.#live = {
        source,
        scale,
        scheduler,
        onReady,
        anchor: options.action.anchor,
        rotation: options.action.rotation,
      };
  }

  public get live(): boolean {
    return this.#live !== undefined;
  }

  public cancelCommit(): void {
    if (this.#live === undefined) this.#abort?.abort();
  }

  public restore(): void {
    this.cancel();
  }

  public cancel(): void {
    this.#abort?.abort();
    this.#requested = undefined;
    this.#prepared = undefined;
    this.#failure = undefined;
  }

  public preview(pointer: PointV1, uniform: boolean): SelectionHandlePreview | null {
    const live = this.#live;
    if (live === undefined) return null;
    const factors = live.scale.factorsAt(pointer, uniform);
    if (!sameFactors(this.#requested?.factors, factors)) {
      const request = { pointer, uniform, factors };
      this.#requested = request;
      this.#failure = undefined;
      this.#abort?.abort();
      this.#schedule(live);
    }
    const basis = this.#prepared?.element ?? live.source;
    const ratio = factors.x / (this.#prepared?.request.factors.x ?? 1);
    return {
      exactElements: [basis],
      textScaleBasis: basis,
      exactPreviewTruncated: true,
      previewFrame: null,
      snapCandidate: null,
      snapGuide: null,
      transform: {
        kind: "scale",
        anchor: live.anchor,
        rotation: live.rotation,
        delta: { x: 0, y: 0 },
        factors: { x: ratio, y: ratio },
      },
    };
  }

  public async settle(): Promise<TextElementV2 | null> {
    while (this.#operation !== undefined) await this.#operation;
    if (this.#failure !== undefined) throw this.#failure;
    return this.#requested !== undefined && this.#prepared?.request === this.#requested
      ? this.#prepared.element
      : null;
  }

  public materializer(): ((element: InkElementV1) => InkElementV1) | undefined {
    const live = this.#live,
      request = this.#requested;
    if (live === undefined || request === undefined) return undefined;
    const basis = this.#prepared?.element ?? live.source;
    const ratio = request.factors.x / (this.#prepared?.request.factors.x ?? 1);
    const frame = scaleElement(
      { ...basis, ranges: [], layout: { version: 1, lines: [] } },
      live.anchor,
      { x: ratio, y: ratio },
    );
    return () => frame;
  }

  public async prepare(
    element: TextElementV2,
    scheduler: TransformSliceScheduler,
  ): Promise<TextElementV2 | null> {
    if (scheduler.isCancelled?.()) return null;
    if (this.#reflow === undefined) return element;
    this.cancel();
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const prepared = await this.#reflow(element, abort.signal, { preservePadding: true });
      return abort.signal.aborted || scheduler.isCancelled?.()
        ? null
        : alignReflowedText(element, prepared);
    } catch (error) {
      if (abort.signal.aborted || scheduler.isCancelled?.()) return null;
      throw error;
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
    }
  }

  #schedule(live: LiveTextScale): void {
    this.#operation ??= Promise.resolve()
      .then(() => this.#run(live))
      .finally(() => {
        this.#operation = undefined;
        if (
          this.#requested !== undefined &&
          this.#prepared?.request !== this.#requested &&
          this.#failure === undefined
        )
          this.#schedule(live);
      });
  }

  async #run(live: LiveTextScale): Promise<void> {
    while (this.#requested !== undefined && this.#prepared?.request !== this.#requested) {
      const request = this.#requested;
      const abort = new AbortController();
      this.#abort = abort;
      const isCancelled = () => abort.signal.aborted || this.#requested !== request;
      const scheduler: TransformSliceScheduler = {
        isCancelled,
        shouldYield: () => live.scheduler.shouldYield(),
        yieldControl: () => live.scheduler.checkpoint(abort.signal, "frame") ?? Promise.resolve(),
      };
      try {
        const scaled = await live.scale.materializeOneTimeSliced(
          live.source,
          request.pointer,
          request.uniform,
          request.factors,
          scheduler,
          "reflow",
        );
        if (scaled === null || isCancelled()) continue;
        if (scaled.kind !== "text") throw new Error("Text scaling must preserve the field kind.");
        const prepared = await this.#reflow!(scaled, abort.signal, { preservePadding: true });
        if (isCancelled()) continue;
        const element = live.scale.stabilizeAnchor([alignReflowedText(scaled, prepared)])[0]!;
        if (element.kind !== "text") throw new Error("Text scaling must preserve the field kind.");
        this.#prepared = { request, element };
        live.onReady();
      } catch (error) {
        if (isCancelled()) continue;
        this.#failure = error instanceof Error ? error : new Error("Text reflow failed.");
        return;
      } finally {
        if (this.#abort === abort) this.#abort = undefined;
      }
    }
  }
}

function sameFactors(left: ScaleFactors | undefined, right: ScaleFactors): boolean {
  return left?.x === right.x && left.y === right.y;
}
