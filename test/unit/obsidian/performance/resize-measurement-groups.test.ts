import { describe, expect, it } from "vitest";

import { OBSIDIAN_RESIZE_SCENARIOS } from "../../../performance/comparison/obsidian-resize";

const durations = Array.from({ length: 600 }, (_, index) => index + 1);
const result = { durations, geometryUpdated: true, pendingBounded: true };
const implementation = { get: <T>() => ({}) as T };

describe("resize measurements from one complete trajectory", () => {
  for (let index = 0; index < 8; index += 1) {
    it(`retains both timing phases for workload ${index}`, async () => {
      const group = `obsidian-resize-${index}`;
      const scenarios = OBSIDIAN_RESIZE_SCENARIOS.filter(
        ({ measurementGroup }) => measurementGroup === group,
      );
      expect(scenarios).toHaveLength(2);
      for (const scenario of scenarios) {
        const kernel = await scenario.create(implementation, 120);
        expect(kernel.measurementSamples?.(result, `${group}-first`)).toEqual([durations[0]]);
        expect(kernel.measurementSamples?.(result, `${group}-frames`)).toBe(durations);
        expect(() => kernel.measurementSamples?.(result, "unknown")).toThrow(
          "Unknown resize measurement",
        );
        expect(() =>
          kernel.measurementSamples?.(result, `obsidian-resize-${index + 1}-first`),
        ).toThrow("Unknown resize measurement");
        await kernel.dispose();
      }
    });
  }
  it("keeps the two distinct move workloads ungrouped", () => {
    const moves = OBSIDIAN_RESIZE_SCENARIOS.filter(({ id }) => id.startsWith("obsidian-move-"));
    expect(moves).toHaveLength(2);
    expect(moves.every(({ measurementGroup }) => measurementGroup === undefined)).toBe(true);
  });
});
