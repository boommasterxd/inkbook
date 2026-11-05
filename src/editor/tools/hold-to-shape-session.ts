import {
  recognizeStrokeSteps,
  type RecognizedShape,
} from "../../domain/recognition/stroke-recognition";
import { MAX_STROKE_POINTS, type PointV1 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { HoldToShapeSettingsV1 } from "../../domain/settings/types";

interface HoldClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): number;
  cancel(handle: number): void;
}

interface HoldToShapeOptions {
  readonly settings: HoldToShapeSettingsV1;
  readonly start: PointV1;
  readonly clock: HoldClock;
  readonly scheduler: WorkScheduler;
  readonly readPoints: () => readonly number[];
  readonly zoom: number;
  readonly isCurrent: () => boolean;
  readonly onPreview: (candidate: RecognizedShape | null) => void;
}

/** A raw pointer session owns one quiet interval and at most one recognition job. */
export class HoldToShapeSession {
  readonly #options: HoldToShapeOptions;
  #anchor: PointV1;
  #previewAt = 0;
  #graceAt = 0;
  #graceTimer: number | undefined;
  #deadlineTimer: number | undefined;
  #controller: AbortController | undefined;
  #generation = 0;
  #disposed = false;
  #recognized: RecognizedShape | null = null;
  #candidate: RecognizedShape | null = null;

  public constructor(options: HoldToShapeOptions) {
    this.#options = options;
    this.#anchor = { ...options.start };
    if (options.settings.enabled) this.#arm();
  }

  public get candidate(): RecognizedShape | null {
    if (!this.#options.isCurrent()) this.dispose();
    return this.#candidate;
  }

  /** Every raw sample matters, including excursions returning within the same frame. */
  public observe(samples: readonly PointV1[]): void {
    if (this.#disposed || !this.#options.settings.enabled) return;
    if (!this.#options.isCurrent()) {
      this.dispose();
      return;
    }
    const tolerance = this.#options.settings.jitterTolerancePx;
    let moved = false;
    for (const sample of samples) {
      const dx = sample.x - this.#anchor.x;
      const dy = sample.y - this.#anchor.y;
      if (dx * dx + dy * dy <= tolerance * tolerance) continue;
      this.#anchor = { x: sample.x, y: sample.y };
      moved = true;
    }
    if (!moved) return;
    this.#cancel(false);
    this.#arm();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancel();
  }

  #arm(): void {
    const { clock, settings } = this.#options;
    const now = clock.now();
    this.#previewAt = now + settings.holdDurationMs;
    this.#graceAt = now + Math.min(100, settings.holdDurationMs / 4);
    if (this.#graceTimer === undefined) this.#schedule("grace");
    if (this.#deadlineTimer === undefined) this.#schedule("deadline");
  }

  /** Movement updates quiet deadlines; owned timers rearm only after an early wake. */
  #schedule(kind: "grace" | "deadline"): void {
    const clock = this.#options.clock;
    const due = () => (kind === "grace" ? this.#graceAt : this.#previewAt);
    const handle = clock.schedule(Math.max(0, due() - clock.now()), () => {
      if (kind === "grace") this.#graceTimer = undefined;
      else this.#deadlineTimer = undefined;
      const generation = this.#generation;
      if (!this.#current(generation)) return;
      if (clock.now() < due()) {
        this.#schedule(kind);
        return;
      }
      if (kind === "deadline") this.#publish(generation);
      else {
        const controller = new AbortController();
        this.#controller = controller;
        void this.#recognize(controller, generation);
      }
    });
    if (kind === "grace") this.#graceTimer = handle;
    else this.#deadlineTimer = handle;
  }

  #cancel(clearTimers = true): void {
    const { clock } = this.#options;
    this.#generation++;
    if (clearTimers) {
      if (this.#graceTimer !== undefined) clock.cancel(this.#graceTimer);
      if (this.#deadlineTimer !== undefined) clock.cancel(this.#deadlineTimer);
      this.#graceTimer = undefined;
      this.#deadlineTimer = undefined;
    }
    this.#controller?.abort();
    this.#controller = undefined;
    this.#recognized = null;
    if (this.#candidate === null) return;
    this.#candidate = null;
    this.#preview(null);
  }

  #current(generation: number): boolean {
    if (this.#disposed || generation !== this.#generation) return false;
    if (this.#options.isCurrent()) return true;
    this.dispose();
    return false;
  }

  async #recognize(controller: AbortController, generation: number): Promise<void> {
    let steps: ReturnType<typeof recognizeStrokeSteps> | undefined;
    try {
      const { scheduler, readPoints, zoom } = this.#options;
      const admission = scheduler.checkpoint(controller.signal, "background");
      if (admission !== undefined) await admission;
      if (!this.#current(generation)) return;
      const source = readPoints();
      if (source.length > MAX_STROKE_POINTS * 3) return;
      // One synchronous copy is bounded by the schema's 16,384 sample capacity.
      // It prevents later raw sampling from mutating a yielded recognition job.
      steps = recognizeStrokeSteps(source.slice(), { zoom });
      while (this.#current(generation) && !controller.signal.aborted) {
        const pending = scheduler.checkpoint(controller.signal, "background");
        if (pending !== undefined) await pending;
        if (!this.#current(generation) || controller.signal.aborted) return;
        const step = steps.next();
        if (!step.done) continue;
        this.#recognized = step.value;
        this.#publish(generation);
        return;
      }
    } catch {
      // Unsupported geometry, cancellation and scheduler shutdown retain raw ink.
    } finally {
      steps?.return(null);
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  #publish(generation: number): void {
    if (!this.#current(generation) || this.#candidate !== null) return;
    if (this.#options.clock.now() < this.#previewAt || this.#recognized === null) return;
    const recognized = this.#recognized;
    this.#recognized = null;
    if (this.#preview(recognized) && this.#current(generation)) this.#candidate = recognized;
  }

  #preview(candidate: RecognizedShape | null): boolean {
    try {
      this.#options.onPreview(candidate);
      return true;
    } catch {
      if (candidate !== null) this.#preview(null);
      return false;
    }
  }
}
