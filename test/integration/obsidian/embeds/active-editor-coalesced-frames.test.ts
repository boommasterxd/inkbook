import { describe, expect, it, vi } from "vitest";

import type { GesturePreview } from "../../../../src/editor/gestures/public";
import {
  CoalescedPointerInput,
  type CoalescedCreationSample,
  type CoalescedFrameSampleMode,
} from "../../../../src/obsidian/embeds/active-editor/coalesced-input";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";

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
  const input = new CoalescedPointerInput({
    dispatchMove: (pointer) => routed.update(pointer),
    frameScheduler: scheduler,
    now: () => 0,
    project: (pointer) => ({
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType === "pen" ? "pen" : "mouse",
      pressure: pointer.pressure,
      x: pointer.clientX,
      y: pointer.clientY,
    }),
  });
  routed = input.wrap(preview);
  return { commit, input, revert, routed, scheduler, updateSamples };
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
