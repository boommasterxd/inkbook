import { afterEach, describe, expect, it, vi } from "vitest";
const batch = vi.hoisted(() => vi.fn());
vi.mock("../../../scripts/performance-batch.mjs", () => ({ runPerformanceBatch: batch }));
import { executePerformanceGate } from "../../../scripts/performance-gate.mjs";
afterEach(() => vi.resetAllMocks());
describe("deterministic performance gate", () => {
  it("runs every requested contract exactly once and returns failures", async () => {
    const violation = { file: "a", test: "capacity", message: "overflow", refreshRate: 120 };
    batch
      .mockResolvedValueOnce({ files: ["a"], violations: [violation] })
      .mockResolvedValueOnce({ files: ["b"], violations: [] });
    const runs = [
      { label: "invariant", refreshRate: 120, testFiles: ["a"] },
      { label: "cadence", refreshRate: 60, testFiles: ["b"] },
    ];
    expect(await executePerformanceGate("/repo", runs)).toEqual([violation]);
    expect(batch.mock.calls).toEqual(
      runs.map(({ testFiles, refreshRate }) => [{ root: "/repo", testFiles, refreshRate }]),
    );
  });
  it.each([[], null, undefined])("rejects empty plans", async (runs) => {
    await expect(executePerformanceGate("/repo", runs)).rejects.toThrow("Empty");
    expect(batch).not.toHaveBeenCalled();
  });
  it("propagates execution errors", async () => {
    batch.mockRejectedValue(new Error("startup failed"));
    await expect(
      executePerformanceGate("/repo", [{ label: "all", refreshRate: 120, testFiles: ["a"] }]),
    ).rejects.toThrow("startup failed");
  });
});
