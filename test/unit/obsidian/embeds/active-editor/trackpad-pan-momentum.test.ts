import { describe, expect, it } from "vitest";

import {
  isTrackpadPanInput,
  responsiveTrackpadPanDelta,
  TRACKPAD_PAN_DEFAULT_IDLE_MS,
  TRACKPAD_PAN_MAX_IDLE_MS,
  TRACKPAD_PAN_MIN_IDLE_MS,
  TRACKPAD_PAN_MAX_RESPONSE,
  TrackpadPanMomentum,
  trackpadPanIdleDelay,
} from "../../../../../src/obsidian/embeds/active-editor/trackpad-pan-momentum";

describe("trackpad pan momentum", () => {
  it("classifies every unshifted pixel-wheel burst without a magnitude cutoff", () => {
    expect(isTrackpadPanInput(input())).toBe(true);
    expect(isTrackpadPanInput(input({ deltaMode: 1 }))).toBe(false);
    expect(isTrackpadPanInput(input({ shiftKey: true }))).toBe(false);
  });

  it("releases after one cadence-derived missing-event window", () => {
    const clock = new Clock();
    const momentum = new TrackpadPanMomentum(clock);
    recordBurst(momentum, clock);

    expect(momentum.advance(55)).toBe(0);
    expect(momentum.active).toBe(true);
    expect(momentum.advance(56)).toBe(0);
    expect(momentum.advance(72)).toBeLessThan(-10);

    expect(momentum.active).toBe(true);
  });

  it("postpones synthetic release while native inertial wheel events continue", () => {
    const clock = new Clock();
    const momentum = new TrackpadPanMomentum(clock);
    recordBurst(momentum, clock);

    clock.advance(23);
    momentum.record(-2);
    expect(momentum.advance(89)).toBe(0);

    expect(momentum.advance(90.5)).toBeLessThan(0);

    expect(momentum.active).toBe(true);
  });

  it("bounds cadence-derived release delay for very fast and sparse input", () => {
    expect(trackpadPanIdleDelay(1)).toBe(TRACKPAD_PAN_MIN_IDLE_MS);
    expect(trackpadPanIdleDelay(80)).toBe(TRACKPAD_PAN_MAX_IDLE_MS);
    expect(trackpadPanIdleDelay(101)).toBe(TRACKPAD_PAN_DEFAULT_IDLE_MS);
    expect(trackpadPanIdleDelay(Number.NaN)).toBe(TRACKPAD_PAN_DEFAULT_IDLE_MS);
  });

  it("keeps slow movement direct and progressively accelerates faster samples", () => {
    const slow = responsiveTrackpadPanDelta(2, 16);
    const medium = responsiveTrackpadPanDelta(12, 16);
    const fast = responsiveTrackpadPanDelta(40, 16);

    expect(slow).toBe(2);
    expect(medium / 12).toBeGreaterThan(1);
    expect(fast / 40).toBe(TRACKPAD_PAN_MAX_RESPONSE);
    expect(responsiveTrackpadPanDelta(-40, 16)).toBe(-fast);
  });

  it("uses event cadence as part of direct and kinetic speed", () => {
    expect(responsiveTrackpadPanDelta(8, 8)).toBeGreaterThan(responsiveTrackpadPanDelta(8, 24));

    const slowClock = new Clock();
    const slow = new TrackpadPanMomentum(slowClock);
    recordTimedBurst(slow, slowClock, 3, 24);
    const slowRelease = slowClock.now + trackpadPanIdleDelay(24);
    const slowTail = slow.advance(slowRelease + 16);

    const fastClock = new Clock();
    const fast = new TrackpadPanMomentum(fastClock);
    recordTimedBurst(fast, fastClock, 12, 8);
    const fastRelease = fastClock.now + trackpadPanIdleDelay(8);
    const fastTail = fast.advance(fastRelease + 16);

    expect(Math.abs(fastTail)).toBeGreaterThan(Math.abs(slowTail) * 4);
  });

  it("drops opposite-direction samples before estimating release velocity", () => {
    const clock = new Clock();
    const momentum = new TrackpadPanMomentum(clock);
    recordTimedBurst(momentum, clock, 12, 16);
    clock.advance(16);
    momentum.record(-12);
    clock.advance(16);
    momentum.record(-12);
    const release = clock.now + trackpadPanIdleDelay(16);

    expect(momentum.advance(release + 16)).toBeLessThan(0);
  });

  it("cancels a pending or active release without leaving frame work", () => {
    const clock = new Clock();
    const momentum = new TrackpadPanMomentum(clock);
    recordBurst(momentum, clock);
    momentum.cancel();

    expect(momentum.active).toBe(false);
    expect(momentum.advance(1_000)).toBe(0);
  });
});

class Clock {
  #now = 0;

  public readonly performance = { now: () => this.#now };

  public get now(): number {
    return this.#now;
  }

  public advance(elapsed: number): void {
    this.#now += elapsed;
  }
}

function recordBurst(momentum: TrackpadPanMomentum, clock: Clock): void {
  momentum.record(-12);
  clock.advance(16);
  momentum.record(-11);
  clock.advance(16);
  momentum.record(-10);
}

function recordTimedBurst(
  momentum: TrackpadPanMomentum,
  clock: Clock,
  delta: number,
  interval: number,
): void {
  momentum.record(delta);
  clock.advance(interval);
  momentum.record(delta);
  clock.advance(interval);
  momentum.record(delta);
}

function input(overrides: Partial<Parameters<typeof isTrackpadPanInput>[0]> = {}) {
  return {
    deltaMode: 0,
    shiftKey: false,
    ...overrides,
  };
}
