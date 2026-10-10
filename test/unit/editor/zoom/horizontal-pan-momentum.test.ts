import { describe, expect, it } from "vitest";

import { HorizontalPanMomentum } from "../../../../src/editor/zoom/index";

const DECAY_PER_SECOND = -Math.log(0.96) * 60;

describe("horizontal touch pan release velocity", () => {
  it("matches movement intervals instead of including an unmeasured first delta", () => {
    const momentum = releasedMomentum();

    expect(momentum.advance(48)).toBeCloseTo(integratedDistance(625, 0.016), 8);

    const unseeded = new HorizontalPanMomentum();
    unseeded.record(10, 16);
    unseeded.record(10, 32);
    expect(unseeded.release(32)).toBe(true);
    expect(unseeded.advance(48)).toBeCloseTo(integratedDistance(625, 0.016), 8);
  });

  it.each([
    [0.79, 32, false],
    [0.8, 32, true],
    [10, 72, true],
    [10, 73, false],
    [10, 153, false],
  ])("uses delta %s and release %s for threshold and stale samples", (delta, release, active) => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(delta, 16);
    momentum.record(delta, 32);

    expect(momentum.release(release)).toBe(active);
    expect(momentum.active).toBe(active);
    if (active) {
      expect(momentum.advance(release + 16)).toBeCloseTo(
        integratedDistance((delta * 1_000) / 16, 0.016),
        8,
      );
    }
  });

  it("keeps only the latest direction and includes its first complete interval", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(20, 16);
    momentum.record(20, 32);
    momentum.record(-4, 48);

    expect(momentum.release(48)).toBe(true);
    expect(momentum.advance(64)).toBeCloseTo(integratedDistance(-250, 0.016), 8);
  });

  it.each([32, 56, 57, 80])(
    "keeps short release pauses but stops stale motion at %i ms",
    (release) => {
      const momentum = new HorizontalPanMomentum();
      momentum.record(0, 0);
      momentum.record(10, 16);
      momentum.record(0, 32);

      const active = release <= 56;
      expect(momentum.release(release)).toBe(active);
      expect(momentum.advance(release + 16)).toBeCloseTo(
        active ? integratedDistance(625, 0.016) : 0,
        8,
      );
    },
  );
});

describe("horizontal touch pan endpoint estimation", () => {
  it.each([1, -1])(
    "matches constant and accelerating fingers at the same final speed in direction %i",
    (direction) => {
      const constant = new HorizontalPanMomentum();
      const accelerating = new HorizontalPanMomentum();
      constant.record(0, 0);
      accelerating.record(0, 0);
      for (let sample = 1; sample <= 6; sample += 1) {
        constant.record(12 * direction, sample * 16);
        accelerating.record((sample * 2 - 1) * direction, sample * 16);
      }

      expect(constant.release(96)).toBe(true);
      expect(accelerating.release(96)).toBe(true);
      const expected = integratedDistance(750 * direction, 0.016);
      expect(constant.advance(112)).toBeCloseTo(expected, 8);
      expect(accelerating.advance(112)).toBeCloseTo(expected, 8);
    },
  );

  it("stops instead of reversing when a deceleration fit overshoots the final direction", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(20, 16);
    momentum.record(1, 32);

    expect(momentum.release(32)).toBe(false);
    expect(momentum.advance(48)).toBe(0);
  });

  it("merges equal-time movement without inventing a zero-duration interval", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(5, 16);
    momentum.record(5, 16);
    momentum.record(0, 16);
    momentum.record(10, 32);

    expect(momentum.release(32)).toBe(true);
    expect(momentum.advance(48)).toBeCloseTo(integratedDistance(625, 0.016), 8);
  });

  it("rejects an unmeasured interval and a release preceding its samples", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(10, 16);
    expect(momentum.release(16)).toBe(false);
    momentum.record(0, 32);
    momentum.record(10, 48);
    expect(momentum.release(47)).toBe(false);
  });

  it("uses a linear fallback when distinct timestamps cannot support a stable quadratic fit", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(2, 1e-12);
    momentum.record(2, 16);

    expect(momentum.release(16)).toBe(true);
    expect(momentum.advance(32)).toBeCloseTo(integratedDistance(187.5, 0.016), 8);
  });

  it("drops movement outside the endpoint sample window", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(1, 16);
    momentum.record(48, 160);
    momentum.record(48, 176);

    expect(momentum.release(176)).toBe(true);
    expect(momentum.advance(192)).toBeCloseTo(integratedDistance(3_000, 0.016), 8);
  });
});

describe("horizontal touch pan sample limits", () => {
  it("bounds retained samples and caps extreme release speed", () => {
    const momentum = new HorizontalPanMomentum();
    for (let sample = 0; sample < 40; sample += 1) momentum.record(1, sample);
    expect(momentum.release(39)).toBe(true);
    expect(momentum.advance(55)).toBeCloseTo(integratedDistance(1_000, 0.016), 8);

    for (const [delta, velocity] of [
      [6, 6_000],
      [100, 8_000],
    ]) {
      const fast = new HorizontalPanMomentum();
      fast.record(0, 0);
      fast.record(delta!, 1);
      expect(fast.release(1)).toBe(true);
      expect(fast.advance(17)).toBeCloseTo(integratedDistance(velocity!, 0.016), 8);
    }
  });

  it("resets the sample baseline after a backwards timestamp", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(-20, 100);
    momentum.record(0, 0);
    momentum.record(10, 16);
    expect(momentum.release(16)).toBe(true);
    expect(momentum.advance(32)).toBeCloseTo(integratedDistance(625, 0.016), 8);
  });

  it("rejects a fit whose cumulative positions overflow", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(Number.MAX_VALUE, 16);
    momentum.record(Number.MAX_VALUE, 32);

    expect(momentum.release(32)).toBe(false);
    expect(momentum.active).toBe(false);
  });
});

describe("horizontal touch pan motion and lifecycle", () => {
  it.each([60, 90, 120, 144, 240])("integrates identical total travel at %i Hz", (refreshRate) => {
    const momentum = releasedMomentum();
    let distance = 0;
    for (let frame = 1; frame <= refreshRate * 2; frame += 1) {
      distance += momentum.advance(32 + (frame * 1_000) / refreshRate);
    }

    expect(distance).toBeCloseTo((625 - 15) / DECAY_PER_SECOND, 8);
    expect(momentum.active).toBe(false);
    expect(momentum.advance(3_000)).toBe(0);
  });

  it("separates sample cutoff from a delayed animation start", () => {
    const momentum = new HorizontalPanMomentum();
    momentum.record(0, 0);
    momentum.record(10, 16);
    momentum.record(10, 32);

    expect(momentum.release(32, 112)).toBe(true);
    expect(momentum.advance(128)).toBeCloseTo(integratedDistance(625, 0.016), 8);
  });

  it("ignores duplicate, backwards, and invalid frames and stops after interruption", () => {
    const momentum = releasedMomentum();
    expect(momentum.advance(32)).toBe(0);
    expect(momentum.advance(31)).toBe(0);
    expect(momentum.advance(Number.NaN)).toBe(0);
    expect(momentum.advance(48)).toBeGreaterThan(0);
    expect(momentum.advance(149)).toBe(0);
    expect(momentum.active).toBe(false);
  });

  it("rejects invalid input and clears motion and samples on cancellation", () => {
    const momentum = releasedMomentum();
    momentum.cancel();
    momentum.record(Number.POSITIVE_INFINITY, 48);
    momentum.record(10, -1);
    momentum.record(10, Number.NaN);
    expect(momentum.release(48)).toBe(false);
    expect(momentum.active).toBe(false);
    expect(momentum.advance(64)).toBe(0);
    expect(momentum.release(Number.NaN)).toBe(false);
    expect(momentum.release(64, -1)).toBe(false);
  });
});

function releasedMomentum(): HorizontalPanMomentum {
  const momentum = new HorizontalPanMomentum();
  momentum.record(0, 0);
  momentum.record(10, 16);
  momentum.record(10, 32);
  momentum.release(32);
  return momentum;
}

function integratedDistance(velocity: number, seconds: number): number {
  return (velocity * (1 - Math.exp(-DECAY_PER_SECOND * seconds))) / DECAY_PER_SECOND;
}
