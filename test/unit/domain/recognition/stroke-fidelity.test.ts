import { afterEach, describe, expect, it, vi } from "vitest";
import * as geometry from "../../../../src/domain/geometry/primitives";
import { observedNormalization, sampledPath } from "./recognition-fixtures";

afterEach(() => vi.restoreAllMocks());

describe("original stroke fidelity ownership", () => {
  it("can cancel a suspended fidelity pass without checking or reading later samples", () => {
    const source = sampledPath(
      [
        [0, 0],
        [400, 0],
      ],
      false,
    );
    const distance = vi.spyOn(geometry, "pointSegmentDistance");
    const { steps, work } = observedNormalization(source);
    let step = steps.next();
    while (!step.done && distance.mock.calls.length === 0) step = steps.next();
    expect(step.done).toBe(false);
    expect(distance).toHaveBeenCalledTimes(1);
    const reads = work.indexedReads;
    steps.return(null);
    expect(distance).toHaveBeenCalledTimes(1);
    expect(work.indexedReads).toBe(reads);
  });
});
