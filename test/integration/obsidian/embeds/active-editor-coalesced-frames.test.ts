import { describe, expect, it, vi } from "vitest";

import type { GesturePreview } from "../../../../src/editor/gestures/public";
import {
  createInputState,
  reduceInput,
  type PointerSample,
} from "../../../../src/editor/input/index";
import { pointerDown } from "../../../fixtures/editor/input-actions";
import {
  CoalescedPointerInput,
  type CoalescedCreationSample,
  type CoalescedFrameSampleMode,
} from "../../../../src/obsidian/embeds/active-editor/coalesced-input";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";

describe("active editor validated input observers", () => {
  it("observes the validated ordered batch after one latest-sample dispatch without rereading", () => {
    const fixture = setup("preserve");
    const samples = [sample(10, 1), sample(20, 2)];
    const getCoalescedEvents = vi.fn(() => samples);
    const observer = vi.fn((batch: readonly CoalescedCreationSample[]) => {
      expect(fixture.dispatchMove).toHaveBeenCalledExactlyOnceWith(batch[1]);
      expect(fixture.project).toHaveBeenCalledTimes(3);
    });

    fixture.input.dispatch({ ...samples[1], getCoalescedEvents } as PointerEvent, false, observer);
    fixture.scheduler.runNext();

    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]?.[0].map(({ x, time }) => [x, time])).toEqual([
      [10, 1],
      [20, 2],
    ]);
    expect(getCoalescedEvents).toHaveBeenCalledOnce();
    expect(fixture.project).toHaveBeenCalledTimes(3);
    expect(fixture.updateSamples.mock.calls[0]?.[0][0]).toBe(observer.mock.calls[0]?.[0][0]);
  });

  it.each(["invalid-time", "throwing-projection"])(
    "never observes a batch with later %s",
    (failure) => {
      const fixture = setup("preserve");
      const observer = vi.fn();
      const later = sample(20, failure === "invalid-time" ? 1 : 3);
      if (failure === "throwing-projection") {
        Object.defineProperty(later, "pressure", {
          get: () => {
            throw new Error("Invalid sample");
          },
        });
      }

      expect(
        fixture.input.dispatch(event([sample(10, 2), later, sample(30, 4)]), false, observer),
      ).toBe(false);

      expect(observer).not.toHaveBeenCalled();
      expect(fixture.dispatchMove).not.toHaveBeenCalled();
      expect(fixture.scheduler.pendingCount).toBe(0);
    },
  );

  it("releases the dispatch batch when an observer fails", () => {
    const fixture = setup("latest");
    const observer = () => {
      throw new Error("Observer failure");
    };

    expect(() =>
      fixture.input.dispatch(event([sample(10, 1), sample(20, 2)]), false, observer),
    ).toThrow("Observer failure");
    fixture.routed.commit();
    fixture.updateSamples.mockClear();
    fixture.routed.update({ pointerId: 1, pointerType: "pen", pressure: 0.5, x: 99, y: 99 });
    fixture.scheduler.runNext();

    expect(fixture.updateSamples).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ x: 99, time: 0 }),
    ]);
    expect(fixture.scheduler.pendingCount).toBe(0);
  });
});

describe("coalesced selection press movement", () => {
  it("starts an out-and-back area with one complete geometry batch", () => {
    const fixture = setup("preserve");
    let state = reduceInput(
      createInputState({ activeTool: "select" }),
      pointerDown({ pointerType: "pen", x: 10, y: 10 }),
    ).state;
    fixture.dispatchMove.mockImplementation((pointer) => {
      const reduction = reduceInput(state, fixture.input.moveAction(pointer, state));
      state = reduction.state;
      for (const effect of reduction.effects) {
        if (effect.type === "update-preview") fixture.routed.update(effect.pointer);
      }
    });
    const samples = [sample(20, 1), sample(10, 2)];
    expect(fixture.input.dispatch(event(samples))).toBe(true);
    expect(state.interaction?.phase).toBe("lasso");
    expect(fixture.dispatchMove).toHaveBeenCalledOnce();
    expect(fixture.scheduler.pendingCount).toBe(1);
    fixture.scheduler.runNext();
    expect(fixture.updateSamples).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ x: 20, y: 20, time: 1 }),
      expect.objectContaining({ x: 10, y: 10, time: 2 }),
    ]);
    const next = fixture.input.moveAction(
      { pointerId: 1, pointerType: "pen", x: 10, y: 10 },
      state,
    );
    expect(next).not.toHaveProperty("maximumMovement");
    expect(fixture.scheduler.pendingCount).toBe(0);
  });
});

describe("active editor coalesced input frames", () => {
  it("preserves ordered stylus samples while publishing once per frame", () => {
    const fixture = setup("preserve");

    dispatchTwoBatches(fixture.input);

    expect(fixture.scheduler.pendingCount).toBe(1);
    expect(fixture.updateSamples).not.toHaveBeenCalled();
    fixture.scheduler.runNext();
    expect(fixture.updateSamples).toHaveBeenCalledOnce();
    expect(fixture.updateSamples.mock.calls[0]?.[0].map(({ x }) => x)).toEqual([10, 20, 30, 40]);
  });

  it("publishes only the latest endpoint sample and flushes it before commit", () => {
    const fixture = setup("latest");

    dispatchTwoBatches(fixture.input);
    expect(fixture.routed.commit()).toBe(true);

    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.scheduler.cancelledFrames).toBe(1);
    expect(fixture.updateSamples).toHaveBeenCalledWith([expect.objectContaining({ x: 40 })]);
    expect(fixture.commit).toHaveBeenCalledOnce();
  });

  it("discards a pending frame before reverting", () => {
    const fixture = setup("preserve");

    fixture.input.dispatch(event([sample(10, 1), sample(20, 2)]));
    fixture.routed.revert();

    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.scheduler.cancelledFrames).toBe(1);
    expect(fixture.updateSamples).not.toHaveBeenCalled();
    expect(fixture.revert).toHaveBeenCalledOnce();
  });

  it("bounds a preserve frame while retaining its ordered endpoints", () => {
    const fixture = setup("preserve");
    const first = Array.from({ length: 4_096 }, (_, index) => sample(index, index));
    const second = Array.from({ length: 4_096 }, (_, index) =>
      sample(index + 4_096, index + 4_096),
    );

    expect(fixture.input.dispatch(event(first))).toBe(true);
    expect(fixture.input.dispatch(event(second))).toBe(true);
    fixture.scheduler.runNext();

    const published = fixture.updateSamples.mock.calls[0]?.[0] ?? [];
    expect(published).toHaveLength(4_096);
    expect(published[0]?.x).toBe(0);
    expect(published[published.length - 1]?.x).toBe(8_191);
    expect(
      published.every((value, index) => index === 0 || value.x > published[index - 1]!.x),
    ).toBe(true);
  });
});

function setup(frameSampleMode: CoalescedFrameSampleMode) {
  const scheduler = new ManualFrameScheduler();
  const commit = vi.fn(() => true);
  const revert = vi.fn();
  const updateSamples = vi.fn<(samples: readonly CoalescedCreationSample[]) => void>();
  const preview = {
    commit,
    frameSampleMode,
    revert,
    update: vi.fn(),
    updateSamples,
  } satisfies GesturePreview & {
    readonly frameSampleMode: CoalescedFrameSampleMode;
    updateSamples(samples: readonly CoalescedCreationSample[]): void;
  };
  let routed: GesturePreview = preview;
  const dispatchMove = vi.fn((pointer: PointerSample) => routed.update(pointer));
  const project = vi.fn((pointer: PointerEvent) => ({
    pointerId: pointer.pointerId,
    pointerType: pointer.pointerType === "pen" ? ("pen" as const) : ("mouse" as const),
    pressure: pointer.pressure,
    x: pointer.clientX,
    y: pointer.clientY,
  }));
  const input = new CoalescedPointerInput({
    dispatchMove,
    frameScheduler: scheduler,
    now: () => 0,
    project,
  });
  routed = input.wrap(preview);
  return { commit, dispatchMove, input, project, revert, routed, scheduler, updateSamples };
}

function event(samples: readonly PointerEvent[]): PointerEvent {
  const dispatched = samples[samples.length - 1]!;
  return { ...dispatched, getCoalescedEvents: () => samples } as PointerEvent;
}

function dispatchTwoBatches(input: CoalescedPointerInput): void {
  input.dispatch(event([sample(10, 1), sample(20, 2)]));
  input.dispatch(event([sample(30, 3), sample(40, 4)]));
}

function sample(x: number, timeStamp: number): PointerEvent {
  return {
    clientX: x,
    clientY: x,
    pointerId: 1,
    pointerType: "pen",
    pressure: 0.5,
    timeStamp,
  } as PointerEvent;
}
