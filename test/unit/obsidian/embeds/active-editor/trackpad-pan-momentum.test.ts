import { describe, expect, it, vi } from "vitest";

import {
  isTrackpadPanInput,
  TRACKPAD_PAN_IDLE_MS,
  TrackpadPanMomentum,
} from "../../../../../src/obsidian/embeds/active-editor/trackpad-pan-momentum";

describe("trackpad pan momentum", () => {
  it("classifies only small unshifted pixel-wheel input as trackpad movement", () => {
    expect(isTrackpadPanInput(input())).toBe(true);
    expect(isTrackpadPanInput(input({ deltaMode: 1 }))).toBe(false);
    expect(isTrackpadPanInput(input({ deltaX: 100 }))).toBe(false);
    expect(isTrackpadPanInput(input({ shiftKey: true }))).toBe(false);
  });

  it("releases a recorded wheel burst after one quiet window", () => {
    const scheduler = new Scheduler();
    const onRelease = vi.fn();
    const momentum = new TrackpadPanMomentum(scheduler, onRelease);
    momentum.record(-10);
    scheduler.advance(16);
    momentum.record(-10);
    scheduler.advance(16);
    momentum.record(-10);

    scheduler.flush();

    expect(scheduler.lastDelay).toBe(TRACKPAD_PAN_IDLE_MS);
    expect(onRelease).toHaveBeenCalledOnce();
    expect(momentum.active).toBe(true);
    expect(momentum.advance(scheduler.now + 16)).toBeLessThan(-10);
  });

  it("restarts the quiet window and cancels pending or active momentum", () => {
    const scheduler = new Scheduler();
    const onRelease = vi.fn();
    const momentum = new TrackpadPanMomentum(scheduler, onRelease);
    momentum.record(10);
    scheduler.advance(16);
    momentum.record(10);
    expect(scheduler.pending).toBe(1);

    scheduler.advance(16);
    momentum.record(10);
    expect(scheduler.pending).toBe(1);
    momentum.cancel();
    scheduler.flush();

    expect(onRelease).not.toHaveBeenCalled();
    expect(momentum.active).toBe(false);
  });
});

class Scheduler {
  readonly #callbacks = new Map<number, () => void>();
  #next = 1;
  #now = 0;
  lastDelay = 0;

  public readonly performance = { now: () => this.#now };

  public get now(): number {
    return this.#now;
  }

  public get pending(): number {
    return this.#callbacks.size;
  }

  public clearTimeout(handle: number): void {
    this.#callbacks.delete(handle);
  }

  public setTimeout(callback: () => void, delay: number): number {
    const handle = this.#next++;
    this.lastDelay = delay;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  public advance(elapsed: number): void {
    this.#now += elapsed;
  }

  public flush(): void {
    this.advance(this.lastDelay);
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

function input(overrides: Partial<Parameters<typeof isTrackpadPanInput>[0]> = {}) {
  return {
    deltaMode: 0,
    deltaX: 12,
    deltaY: 1,
    shiftKey: false,
    ...overrides,
  };
}
