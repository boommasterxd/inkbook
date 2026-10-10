import type { GesturePreview } from "../../../editor/gestures/public";
import type { GesturePreviewStart } from "../../../editor/gestures/public";
import { isValidPointerSample, type PointerSample } from "../../../editor/input/index";
import { hasPenContact } from "../../../editor/input/pointer-validation";
import type { WorkPriority } from "../../../domain/scheduling/work-scheduler";

// A frame batch is bounded independently of the lifetime capacity of one stroke.
const MAX_COALESCED_SAMPLES = 4096;

export type CoalescedCreationSample = GesturePreviewStart["pointer"] & {
  readonly time: number;
};

interface CoalescedGesturePreview extends GesturePreview {
  updateSamples(samples: readonly CoalescedCreationSample[]): void;
}

export type CoalescedFrameSampleMode = "latest" | "preserve";

export interface CoalescedFramePreview extends CoalescedGesturePreview {
  readonly frameSampleMode: CoalescedFrameSampleMode;
}

export interface CoalescedFrameScheduler {
  cancelFrame(handle: number): void;
  requestFrame(callback: FrameRequestCallback, priority?: WorkPriority): number;
}

function updateGesturePreview(
  preview: GesturePreview,
  samples: readonly CoalescedCreationSample[],
): void {
  if (samples.length === 0) return;
  if (isCoalescedGesturePreview(preview)) {
    preview.updateSamples(samples);
    return;
  }
  for (const sample of samples) preview.update(sample);
}

function isCoalescedGesturePreview(preview: GesturePreview): preview is CoalescedGesturePreview {
  return "updateSamples" in preview && typeof preview.updateSamples === "function";
}

export interface CoalescedPointerInputOptions {
  readonly dispatchMove: (pointer: PointerSample) => void;
  readonly frameScheduler?: CoalescedFrameScheduler;
  readonly now: () => number;
  readonly project: (event: PointerEvent) => PointerSample;
}

export class CoalescedPointerInput {
  readonly #dispatchMove: (pointer: PointerSample) => void;
  readonly #frameScheduler: CoalescedFrameScheduler | undefined;
  readonly #now: () => number;
  #pending: readonly CoalescedCreationSample[] | undefined;
  readonly #project: (event: PointerEvent) => PointerSample;

  public constructor(options: CoalescedPointerInputOptions) {
    this.#dispatchMove = options.dispatchMove;
    this.#frameScheduler = options.frameScheduler;
    this.#now = options.now;
    this.#project = options.project;
  }

  /**
   * Validates the complete batch before dispatch, including filtered terminal pen samples.
   * The synchronous observer borrows projected samples after the latest-sample move dispatch.
   */
  public dispatch(
    event: PointerEvent,
    penContactOnly = false,
    observeSamples?: (samples: readonly CoalescedCreationSample[]) => void,
  ): boolean {
    const source = coalescedEvents(event);
    if (source === null) return false;
    const expected = this.#projectSample(event);
    if (expected === null) return false;
    const pending = this.#validatedSamples(
      source.length === 0 ? [event] : source,
      expected,
      event,
      penContactOnly,
    );
    if (pending === null) return false;
    this.#pending = pending;
    const pointer = this.#pending[this.#pending.length - 1];
    try {
      if (pointer !== undefined) this.#dispatchMove(pointer);
      observeSamples?.(pending);
    } finally {
      this.#pending = undefined;
    }
    return pointer !== undefined || penContactOnly;
  }

  public wrap(preview: GesturePreview): GesturePreview {
    return this.wrapProjected(preview, (sample) => sample);
  }

  public wrapProjected(
    preview: GesturePreview,
    project: (sample: CoalescedCreationSample) => CoalescedCreationSample,
  ): GesturePreview {
    const frame = isCoalescedFramePreview(preview)
      ? new CoalescedPreviewFrame(preview, project, this.#frameScheduler)
      : null;
    return {
      commit: () => {
        frame?.flush();
        return preview.commit();
      },
      revert: () => {
        frame?.discard();
        preview.revert();
      },
      update: (pointer) => {
        const samples = this.#pending;
        const incoming = samples ?? [{ ...pointer, time: this.#now() }];
        if (frame === null) updateGesturePreview(preview, incoming.map(project));
        else frame.update(incoming);
      },
    };
  }

  #validatedSamples(
    source: readonly PointerEvent[],
    expected: PointerSample,
    dispatchedEvent: PointerEvent,
    penContactOnly: boolean,
  ): readonly CoalescedCreationSample[] | null {
    const dispatchedTime = dispatchedEvent.timeStamp;
    const samples: CoalescedCreationSample[] = [];
    let previousTime = Number.NEGATIVE_INFINITY;
    try {
      for (let index = 0; index < source.length; index += 1) {
        const event = source[index];
        if (event === undefined) return null;
        if (
          event.pointerId !== expected.pointerId ||
          !Number.isFinite(event.timeStamp) ||
          event.timeStamp < 0 ||
          event.timeStamp < previousTime
        ) {
          return null;
        }
        const pointer = this.#project(event);
        if (
          !isValidPointerSample(pointer) ||
          pointer.pointerId !== expected.pointerId ||
          pointer.pointerType !== expected.pointerType
        ) {
          return null;
        }
        if (!penContactOnly || hasPenContact(event)) {
          samples.push({ ...pointer, time: event.timeStamp });
        }
        previousTime = event.timeStamp;
      }
      if (!Number.isFinite(dispatchedTime) || dispatchedTime < 0 || dispatchedTime < previousTime) {
        return null;
      }
      const dispatched = { ...expected, time: dispatchedTime };
      if (
        (!penContactOnly || hasPenContact(dispatchedEvent)) &&
        !sameCreationSample(samples[samples.length - 1], dispatched)
      ) {
        if (samples.length === MAX_COALESCED_SAMPLES) samples.pop();
        samples.push(dispatched);
      }
    } catch {
      return null;
    }
    return samples;
  }

  #projectSample(event: PointerEvent): PointerSample | null {
    try {
      const pointer = this.#project(event);
      return isValidPointerSample(pointer) ? pointer : null;
    } catch {
      return null;
    }
  }
}

class CoalescedPreviewFrame {
  readonly #preview: CoalescedFramePreview;
  readonly #project: (sample: CoalescedCreationSample) => CoalescedCreationSample;
  readonly #scheduler: CoalescedFrameScheduler | undefined;
  #frameHandle: number | undefined;
  #pending: readonly CoalescedCreationSample[] = [];

  public constructor(
    preview: CoalescedFramePreview,
    project: (sample: CoalescedCreationSample) => CoalescedCreationSample,
    scheduler: CoalescedFrameScheduler | undefined,
  ) {
    this.#preview = preview;
    this.#project = project;
    this.#scheduler = scheduler;
  }

  public update(samples: readonly CoalescedCreationSample[]): void {
    if (samples.length === 0) return;
    this.#pending =
      this.#preview.frameSampleMode === "latest"
        ? [samples[samples.length - 1]!]
        : mergeFrameSamples(this.#pending, samples);
    if (this.#scheduler === undefined) {
      this.flush();
      return;
    }
    if (this.#frameHandle !== undefined) return;
    let completedSynchronously = false;
    let handle = 0;
    handle = this.#scheduler.requestFrame(() => {
      completedSynchronously = true;
      if (this.#frameHandle === handle) this.#frameHandle = undefined;
      this.#publish();
    }, "input");
    if (!completedSynchronously) this.#frameHandle = handle;
  }

  public flush(): void {
    this.#cancelFrame();
    this.#publish();
  }

  public discard(): void {
    this.#cancelFrame();
    this.#pending = [];
  }

  #cancelFrame(): void {
    if (this.#frameHandle === undefined) return;
    this.#scheduler?.cancelFrame(this.#frameHandle);
    this.#frameHandle = undefined;
  }

  #publish(): void {
    const samples = this.#pending;
    if (samples.length === 0) return;
    this.#pending = [];
    this.#preview.updateSamples(samples.map(this.#project));
  }
}

function isCoalescedFramePreview(preview: GesturePreview): preview is CoalescedFramePreview {
  return (
    isCoalescedGesturePreview(preview) &&
    "frameSampleMode" in preview &&
    (preview.frameSampleMode === "latest" || preview.frameSampleMode === "preserve")
  );
}

function mergeFrameSamples(
  current: readonly CoalescedCreationSample[],
  incoming: readonly CoalescedCreationSample[],
): readonly CoalescedCreationSample[] {
  const merged = [...current, ...incoming];
  if (merged.length <= MAX_COALESCED_SAMPLES) return merged;
  const compacted: CoalescedCreationSample[] = [];
  const lastIndex = merged.length - 1;
  for (let index = 0; index < MAX_COALESCED_SAMPLES; index += 1) {
    const sourceIndex = Math.round((index * lastIndex) / (MAX_COALESCED_SAMPLES - 1));
    compacted.push(merged[sourceIndex]!);
  }
  return compacted;
}

function sameCreationSample(
  left: CoalescedCreationSample | undefined,
  right: CoalescedCreationSample,
): boolean {
  return (
    left !== undefined &&
    left.pointerId === right.pointerId &&
    left.pointerType === right.pointerType &&
    left.x === right.x &&
    left.y === right.y &&
    left.pressure === right.pressure &&
    left.time === right.time
  );
}

function coalescedEvents(event: PointerEvent): readonly PointerEvent[] | null {
  if (typeof event.getCoalescedEvents !== "function") return [];
  try {
    const samples: unknown = event.getCoalescedEvents();
    return Array.isArray(samples) && samples.length <= MAX_COALESCED_SAMPLES
      ? (samples as PointerEvent[])
      : null;
  } catch {
    return null;
  }
}
