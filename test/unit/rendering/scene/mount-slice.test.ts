import { describe, expect, it } from "vitest";

import { MountSlice } from "../../../../src/rendering/scene/mount-slice";

describe("MountSlice minimum progress", () => {
  it("admits one bounded element when the 240 Hz deadline is already exhausted", () => {
    const slice = new MountSlice(2.29, () => 3);
    const expensivePath = { geometry: 100_000, strokePoints: 100_000 };

    expect(slice.blockingReason(expensivePath)).toBeUndefined();
    slice.record(expensivePath);
    expect(slice.blockingReason({ geometry: 1, strokePoints: 0 })).toBe("deadline");
    expect(slice.elements).toBe(1);
  });
});
