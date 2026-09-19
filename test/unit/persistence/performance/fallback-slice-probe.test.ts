import { describe, expect, it } from "vitest";

import { FallbackSliceProbe } from "../../../fixtures/persistence/fallback-slice-probe";

describe("fallback scheduling observations", () => {
  it("records completed yields and does not count operation completion as a yield", async () => {
    const atWait: number[] = [];
    const probe = new FallbackSliceProbe(async () => {
      atWait.push(probe.yields);
    });
    probe.startOperation("validation");
    await probe.yieldControl();
    await probe.yieldControl();
    probe.finishOperation();
    expect(atWait).toEqual([1, 2]);
    expect(probe.yields).toBe(2);
    expect(probe.operations.get("validation")?.yields).toBe(2);
  });

  it("accumulates repeated byte work between yields and includes the final slice", async () => {
    const probe = new FallbackSliceProbe(async () => undefined);
    probe.recordBytes(999);
    probe.startOperation("export");
    probe.recordBytes(100);
    probe.recordBytes(200);
    await probe.yieldControl();
    probe.recordBytes(400);
    probe.finishOperation();
    expect(probe.operations.get("export")).toMatchObject({
      totalBytes: 700,
      maximumSliceBytes: 400,
    });
    probe.startOperation("read-back");
    probe.recordBytes(50);
    probe.finishOperation();
    expect(probe.operations.get("read-back")).toMatchObject({
      totalBytes: 50,
      maximumSliceBytes: 50,
    });
  });

  it("keeps operation order and consumes each observed input pause once", async () => {
    const probe = new FallbackSliceProbe(async () => undefined);
    expect(probe.isInputActive()).toBe(false);
    probe.startOperation("validation");
    for (const active of [true, true, false, false]) {
      expect(probe.isInputActive()).toBe(active);
      await probe.yieldControl();
    }
    probe.finishOperation();
    expect(probe.isInputActive()).toBe(false);
    probe.startOperation("clipboard");
    expect(probe.isInputActive()).toBe(true);
    await probe.yieldControl();
    await probe.yieldControl();
    probe.finishOperation();
    expect([...probe.operations.keys()]).toEqual(["validation", "clipboard"]);
    expect(probe.operations.get("validation")).toEqual({
      totalBytes: 0,
      maximumSliceBytes: 0,
      yields: 4,
      inputPauseYields: 2,
      syntheticInputSamples: 2,
    });
    expect(probe.operations.get("clipboard")).toEqual({
      totalBytes: 0,
      maximumSliceBytes: 0,
      yields: 2,
      inputPauseYields: 1,
      syntheticInputSamples: 1,
    });
    expect(probe.yields).toBe(6);
  });
});
