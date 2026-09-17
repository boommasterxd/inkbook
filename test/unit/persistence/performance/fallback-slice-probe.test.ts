import { describe, expect, it } from "vitest";

import { FallbackSliceProbe } from "../../../fixtures/persistence/fallback-slice-probe";

describe("fallback active-slice measurement", () => {
  it("includes every active span and the final span while excluding owned waits", async () => {
    let now = 100;
    const atWait: number[][] = [];
    const probe = new FallbackSliceProbe(
      () => now,
      async () => {
        atWait.push([...probe.durations]);
        now += 1_000;
      },
    );
    probe.startOperation("validation");
    now += 0.125;
    await probe.yieldControl();
    now += 0.25;
    await probe.yieldControl();
    now += 0.5;
    probe.finishOperation();

    expect(atWait).toEqual([[0.125], [0.125, 0.25]]);
    expect(probe.durations).toEqual([0.125, 0.25, 0.5]);
    expect(probe.operations.get("validation")?.durations).toEqual(probe.durations);
    expect(probe.durations.reduce((total, duration) => total + duration, 0)).toBe(0.875);
  });

  it("keeps operation order, independent spans, and input-pause accounting", async () => {
    let now = 0;
    const probe = new FallbackSliceProbe(
      () => now,
      async () => {
        now += 100;
      },
    );
    expect(probe.isInputActive()).toBe(false);
    probe.startOperation("validation");
    for (const active of [true, true, false, false]) {
      expect(probe.isInputActive()).toBe(active);
      now += 0.25;
      await probe.yieldControl();
    }
    now += 0.125;
    probe.finishOperation();
    expect(probe.isInputActive()).toBe(false);
    now += 200;
    probe.startOperation("clipboard");
    expect(probe.isInputActive()).toBe(true);
    now += 0.5;
    await probe.yieldControl();
    now += 0.25;
    await probe.yieldControl();
    now += 0.125;
    probe.finishOperation();

    expect([...probe.operations.keys()]).toEqual(["validation", "clipboard"]);
    expect(probe.operations.get("validation")).toEqual({
      durations: [0.25, 0.25, 0.25, 0.25, 0.125],
      inputPauseYields: 2,
      syntheticInputSamples: 2,
    });
    expect(probe.operations.get("clipboard")).toEqual({
      durations: [0.5, 0.25, 0.125],
      inputPauseYields: 1,
      syntheticInputSamples: 1,
    });
    expect(probe.durations).toEqual([0.25, 0.25, 0.25, 0.25, 0.125, 0.5, 0.25, 0.125]);
  });
});
