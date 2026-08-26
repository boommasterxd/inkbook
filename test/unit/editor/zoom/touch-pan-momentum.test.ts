import { describe, expect, it } from "vitest";

import { TouchPanMomentum } from "../../../../src/editor/zoom/index";

describe("touch pan momentum", () => {
  it("starts only from a recent release above the velocity threshold", () => {
    const slow = new TouchPanMomentum();
    slow.record(1, 0);
    slow.record(1, 20);

    expect(slow.release(20)).toBe(false);
    expect(slow.active).toBe(false);

    const flick = new TouchPanMomentum();
    flick.record(10, 0);
    flick.record(10, 16);
    flick.record(10, 32);

    expect(flick.release(32)).toBe(true);
    expect(flick.advance(48)).toBeGreaterThan(0);
  });

  it("caps release speed and decays by elapsed time", () => {
    const momentum = new TouchPanMomentum();
    momentum.record(100, 0);
    momentum.record(100, 1);
    momentum.release(1);

    const first = momentum.advance(1 + 1_000 / 60);
    const second = momentum.advance(1 + 2_000 / 60);

    expect(first).toBeGreaterThan(60);
    expect(first).toBeLessThan(67);
    expect(second).toBeLessThan(first);
  });

  it("produces nearly equal travel at 60 and 120 Hz", () => {
    const sixty = releasedMomentum();
    const oneTwenty = releasedMomentum();

    const sixtyTravel = travel(sixty, 10, 1_000 / 60);
    const oneTwentyTravel = travel(oneTwenty, 20, 1_000 / 120);

    expect(oneTwentyTravel).toBeCloseTo(sixtyTravel, -1);
  });

  it("stops instead of jumping after an interrupted frame sequence", () => {
    const momentum = releasedMomentum();

    expect(momentum.advance(200)).toBe(0);
    expect(momentum.active).toBe(false);
  });

  it("clears samples and active motion on cancellation", () => {
    const momentum = releasedMomentum();

    momentum.cancel();

    expect(momentum.active).toBe(false);
    expect(momentum.release(48)).toBe(false);
  });
});

function releasedMomentum(): TouchPanMomentum {
  const momentum = new TouchPanMomentum();
  momentum.record(10, 0);
  momentum.record(10, 16);
  momentum.record(10, 32);
  momentum.release(32);
  return momentum;
}

function travel(momentum: TouchPanMomentum, frames: number, frameDuration: number): number {
  let distance = 0;
  for (let frame = 1; frame <= frames; frame += 1) {
    distance += momentum.advance(32 + frame * frameDuration);
  }
  return distance;
}
