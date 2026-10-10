import { describe, expect, it } from "vitest";

import {
  TrackpadPanMomentum,
  trackpadPanSampleTime,
} from "../../../../../src/obsidian/embeds/active-editor/trackpad-pan-momentum";

function burst(delta = 8, interval = 8): TrackpadPanMomentum {
  const momentum = new TrackpadPanMomentum();
  for (let sample = 0; sample < 3; sample += 1) {
    momentum.record(delta, sample * interval, true);
  }
  return momentum;
}

describe("trackpad quiet release", () => {
  it("waits through three regular intervals and the 40-ms native-tail arrival", () => {
    const momentum = burst();
    expect(momentum.advance(24)).toBe(0);
    expect(momentum.advance(32)).toBe(0);
    expect(momentum.advance(40)).toBe(0);

    momentum.record(2, 40, false);
    expect(momentum.advance(48)).toBe(0);
    expect(momentum.advance(80)).toBe(0);
    expect(momentum.active).toBe(false);
  });

  it("adapts to gaps growing from 32 to 40 ms without moving during a pause", () => {
    const momentum = burst(8, 32);
    for (const time of [72, 88, 104]) expect(momentum.advance(time)).toBe(0);
    momentum.record(8, 104, true);
    expect(momentum.advance(176)).toBe(0);
    expect(momentum.advance(184)).toBe(0);
    expect(momentum.advance(192)).toBeGreaterThan(0);
  });

  it("uses measured release speed independently of its quiet delay", () => {
    const slow = burst(2);
    const fast = burst(16);
    expect(slow.advance(48)).toBe(0);
    expect(fast.advance(48)).toBe(0);
    const slowTravel = slow.advance(56);
    const fastTravel = fast.advance(56);
    expect(slowTravel).toBeGreaterThan(0);
    expect(fastTravel).toBeGreaterThan(slowTravel);
  });

  it("cancels an active tail before recording a reversed direct burst", () => {
    const momentum = burst();
    expect(momentum.advance(56)).toBeGreaterThan(0);
    momentum.record(-8, 64, true);
    expect(momentum.advance(72)).toBe(0);
    momentum.record(-8, 72, true);
    expect(momentum.advance(104)).toBe(0);
    expect(momentum.advance(112)).toBeLessThan(0);
  });

  it("keeps native bursts free of synthetic inertia until more than 120 ms idle", () => {
    const momentum = burst();
    momentum.record(4, 24, false);
    momentum.record(2, 32, true);
    expect(momentum.advance(80)).toBe(0);
    expect(momentum.active).toBe(false);
    momentum.record(8, 153, true);
    momentum.record(8, 161, true);
    expect(momentum.advance(201)).toBeGreaterThan(0);
  });

  it("does not release sparse or interrupted samples", () => {
    const momentum = new TrackpadPanMomentum();
    momentum.record(8, 0, true);
    expect(momentum.advance(48)).toBe(0);
    expect(momentum.active).toBe(false);
    momentum.record(8, 200, true);
    momentum.record(8, 400, true);
    expect(momentum.advance(448)).toBe(0);
    momentum.record(8, 408, true);
    momentum.cancel();
    expect(momentum.active).toBe(false);
    expect(momentum.advance(448)).toBe(0);
  });

  it("rejects invalid samples and rebases backwards timestamps", () => {
    const momentum = new TrackpadPanMomentum();
    momentum.record(Number.NaN, 0, true);
    momentum.record(8, Number.NaN, true);
    momentum.record(8, -1, true);
    expect(momentum.active).toBe(false);
    momentum.record(8, 100, true);
    momentum.record(8, 0, true);
    momentum.record(8, 8, true);
    expect(momentum.advance(48)).toBeGreaterThan(0);
  });
});

describe("trackpad event clock", () => {
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 101, 1_700_000_000_000])(
    "falls back to the owning clock for timestamp %s",
    (timestamp) => expect(trackpadPanSampleTime(timestamp, 100)).toBe(100),
  );

  it("preserves a valid event timestamp instead of its delayed delivery time", () => {
    expect(trackpadPanSampleTime(90, 100)).toBe(90);
    expect(trackpadPanSampleTime(0, 100)).toBe(0);
  });
});
