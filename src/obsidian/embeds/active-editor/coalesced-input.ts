import type { GesturePreview } from "../../../editor/gestures/public";
import type { GesturePreviewStart } from "../../../editor/gestures/public";
import { isValidPointerSample, type PointerSample } from "../../../editor/input/index";
import { MAX_STROKE_POINTS } from "../../../domain/schema/public";

const MAX_COALESCED_SAMPLES_PER_EVENT = MAX_STROKE_POINTS;

export type CoalescedCreationSample = GesturePreviewStart["pointer"] & {
  readonly time: number;
};

interface CoalescedGesturePreview extends GesturePreview {
  updateSamples(samples: readonly CoalescedCreationSample[]): void;
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
  readonly now: () => number;
  readonly project: (event: PointerEvent) => PointerSample;
}

export class CoalescedPointerInput {
  readonly #dispatchMove: (pointer: PointerSample) => void;
  readonly #now: () => number;
  #pending: readonly CoalescedCreationSample[] | undefined;
  readonly #project: (event: PointerEvent) => PointerSample;

  public constructor(options: CoalescedPointerInputOptions) {
    this.#dispatchMove = options.dispatchMove;
    this.#now = options.now;
    this.#project = options.project;
  }

  public dispatch(event: PointerEvent): boolean {
    const source = coalescedEvents(event);
    if (source === null) return false;
    const expected = this.#projectSample(event);
    if (expected === null) return false;
    const pending = this.#validatedSamples(
      source.length === 0 ? [event] : source,
      expected,
      event.timeStamp,
    );
    if (pending === null) return false;
    this.#pending = pending;
    const pointer = this.#pending[this.#pending.length - 1];
    try {
      if (pointer !== undefined) this.#dispatchMove(pointer);
    } finally {
      this.#pending = undefined;
    }
    return pointer !== undefined;
  }

  public wrap(preview: GesturePreview): GesturePreview {
    return this.wrapProjected(preview, (sample) => sample);
  }

  public wrapProjected(
    preview: GesturePreview,
    project: (sample: CoalescedCreationSample) => CoalescedCreationSample,
  ): GesturePreview {
    return {
      commit: () => preview.commit(),
      revert: () => preview.revert(),
      update: (pointer) => {
        const samples = this.#pending;
        updateGesturePreview(
          preview,
          (samples ?? [{ ...pointer, time: this.#now() }]).map(project),
        );
      },
    };
  }

  #validatedSamples(
    source: readonly PointerEvent[],
    expected: PointerSample,
    dispatchedTime: number,
  ): readonly CoalescedCreationSample[] | null {
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
        samples.push({ ...pointer, time: event.timeStamp });
        previousTime = event.timeStamp;
      }
      if (!Number.isFinite(dispatchedTime) || dispatchedTime < 0 || dispatchedTime < previousTime) {
        return null;
      }
      const dispatched = { ...expected, time: dispatchedTime };
      if (!sameCreationSample(samples[samples.length - 1], dispatched)) {
        if (samples.length === MAX_COALESCED_SAMPLES_PER_EVENT) samples.pop();
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
    return Array.isArray(samples) && samples.length <= MAX_COALESCED_SAMPLES_PER_EVENT
      ? (samples as PointerEvent[])
      : null;
  } catch {
    return null;
  }
}
