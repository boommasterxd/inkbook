import { describe, expect, it, onTestFinished, vi } from "vitest";

import { HorizontalPanMomentum } from "../../../../../src/editor/zoom/horizontal-pan-momentum";
import {
  beginTouchPan as beginPan,
  expectCancelledTouchPan,
  touchPanBatch as batch,
  touchPanEvent as event,
  touchPanHarness as setup,
} from "../../../../fixtures/obsidian/touch-pan-samples";

const COALESCED_CAPACITY = 4_096;
const VELOCITY_CAPACITY = 32;

describe("touch pan velocity work and ownership", () => {
  it("projects a maximum batch once and forwards every velocity sample with one move dispatch", () => {
    const h = setup();
    const momentum = new HorizontalPanMomentum();
    h.recordTouchPan.mockImplementation((delta: number, time: number) =>
      momentum.record(delta, time),
    );
    h.releaseTouchPan.mockImplementation((time: number) => momentum.release(time));
    h.cancelPanMomentum.mockImplementation(() => momentum.cancel());
    beginPan(h);
    const samples = touchSamples(COALESCED_CAPACITY);
    const getCoalescedEvents = dispatchBatch(h, samples);

    expect(getCoalescedEvents).toHaveBeenCalledOnce();
    expect(h.screenPointer).toHaveBeenCalledTimes(COALESCED_CAPACITY + 2);
    expect(h.recordTouchPan).toHaveBeenCalledTimes(COALESCED_CAPACITY);
    expect(h.recordTouchPan.mock.calls.every(([delta]) => delta === 1)).toBe(true);
    expect(h.recordTouchPan).toHaveBeenLastCalledWith(1, COALESCED_CAPACITY + 8);
    expect(h.dispatch.mock.calls.map(([action]) => action.type)).toEqual(["pointer-move"]);
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.hit).not.toHaveBeenCalled();

    h.pointer.handlePointerUp(event(150 + COALESCED_CAPACITY, COALESCED_CAPACITY + 9));
    expect(h.recordTouchPan).toHaveBeenCalledTimes(COALESCED_CAPACITY);
    expect(h.releaseTouchPan).toHaveBeenCalledOnce();
    expect(momentum.active).toBe(true);
    h.pointer.handlePointerCancel(event(150 + COALESCED_CAPACITY, COALESCED_CAPACITY + 10));
    expect(momentum.active).toBe(false);
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.timers.size).toBe(0);
  });

  it.each(["invalid", "oversized"] as const)(
    "rejects a %s capacity batch without publishing partial pan work",
    (kind) => {
      const h = setup();
      beginPan(h);
      const samples = touchSamples(COALESCED_CAPACITY + (kind === "oversized" ? 1 : 0));
      if (kind === "invalid")
        samples[samples.length - 1] = event(4_246, 4_104, { pressure: Number.NaN });
      const getCoalescedEvents = dispatchBatch(h, samples);

      expect(getCoalescedEvents).toHaveBeenCalledOnce();
      expect(h.screenPointer).toHaveBeenCalledTimes(
        kind === "oversized" ? 1 : COALESCED_CAPACITY + 2,
      );
      expectCancelledTouchPan(h);
      expect(h.measure).not.toHaveBeenCalled();
      expect(h.hit).not.toHaveBeenCalled();
    },
  );

  it("reuses two fixed sample buffers and bounds fit reads after saturation, cancellation and reversal", () => {
    const resources = observeSampleBuffers();
    const momentum = new HorizontalPanMomentum();
    expect(resources.buffers.map((buffer) => buffer.length)).toEqual([
      VELOCITY_CAPACITY,
      VELOCITY_CAPACITY,
    ]);
    expect(resources.buffers.reduce((bytes, buffer) => bytes + buffer.byteLength, 0)).toBe(512);

    for (let sample = 0; sample < COALESCED_CAPACITY; sample += 1) momentum.record(1, sample);
    expect(resources.reads).toBeLessThanOrEqual(COALESCED_CAPACITY * 2);
    expect(resources.writes).toBeLessThanOrEqual(COALESCED_CAPACITY * 2);
    resources.reset();
    expect(momentum.release(COALESCED_CAPACITY - 1)).toBe(true);
    // One latest-time read, 32 window reads and 67 scalar reads for the endpoint fit.
    expect(resources.reads).toBeLessThanOrEqual(100);
    expect(resources.reads).toBeGreaterThan(VELOCITY_CAPACITY * 2);
    resources.reset();
    expect(momentum.advance(COALESCED_CAPACITY + 15)).toBeGreaterThan(0);
    momentum.cancel();
    expect(momentum.advance(COALESCED_CAPACITY + 31)).toBe(0);
    expect(momentum.release(COALESCED_CAPACITY + 31)).toBe(false);
    expect(resources.reads).toBe(0);
    expect(resources.writes).toBe(0);

    momentum.record(0, 5_000);
    momentum.record(10, 5_016);
    momentum.record(-10, 5_032);
    momentum.record(-20, 5_048);
    resources.reset();
    expect(momentum.release(5_048)).toBe(true);
    expect(momentum.advance(5_064)).toBeLessThan(0);
    expect(resources.reads).toBeLessThanOrEqual(100);
    momentum.cancel();
    expect(resources.buffers).toHaveLength(2);
  });
});

function dispatchBatch(h: ReturnType<typeof setup>, samples: PointerEvent[]) {
  const getCoalescedEvents = vi.fn(() => samples);
  for (const spy of [h.screenPointer, h.recordTouchPan, h.dispatch, h.measure, h.hit])
    spy.mockClear();
  h.pointer.handlePointerMove(batch(samples, getCoalescedEvents));
  return getCoalescedEvents;
}

function touchSamples(count: number): PointerEvent[] {
  return Array.from({ length: count }, (_, index) => event(151 + index, 9 + index));
}

function observeSampleBuffers() {
  const resources = {
    buffers: [] as Float64Array[],
    reads: 0,
    writes: 0,
    reset() {
      this.reads = 0;
      this.writes = 0;
    },
  };
  vi.stubGlobal(
    "Float64Array",
    new Proxy(Float64Array, {
      construct(target, args: [number]) {
        const buffer = new target(...args);
        resources.buffers.push(buffer);
        return new Proxy(buffer, {
          get(array, key) {
            if (typeof key === "string" && /^\d+$/.test(key)) resources.reads += 1;
            return Reflect.get(array, key, array) as unknown;
          },
          set(array, key, value: number) {
            if (typeof key === "string" && /^\d+$/.test(key)) resources.writes += 1;
            return Reflect.set(array, key, value, array);
          },
        });
      },
    }),
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return resources;
}
