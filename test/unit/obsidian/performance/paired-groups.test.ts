import { describe, expect, it, vi } from "vitest";
import type { ComparisonScenario } from "../../../performance/comparison/contracts";
import { runPairedScenarios } from "../../../performance/comparison/paired-runner";
import { groupComparisonScenarios } from "../../../performance/comparison/paired-groups";

function groupedFixture() {
  const reset = vi.fn();
  const dispose = vi.fn();
  const verify = vi.fn();
  const work = vi.fn();
  const select = vi.fn((_result: unknown, metricId?: string): readonly number[] => {
    if (metricId === "first") return [2];
    if (metricId === "all") return [2, 3, 4];
    throw new Error(`Unknown metric: ${metricId}`);
  });
  const create = vi.fn(() => ({
    reset,
    dispose,
    verify,
    measurementSamples: select,
    *run() {
      for (let index = 0; index < 3; index += 1) {
        work();
        yield;
      }
      return "final";
    },
  }));
  const first: ComparisonScenario = {
    id: "first",
    modules: ["module"],
    covers: [],
    measurementGroup: "workload",
    execution: "sequence",
    sequenceLength: 3,

    warmupOperations: 0,
    create,
  };
  const unused = vi.fn(() => {
    throw new Error("Non-representative fixture executed");
  });
  const all: ComparisonScenario = { ...first, id: "all", create: unused };
  const options = {
    scenarios: [first, all],
    refreshRate: 240,
    reference: {
      get<T>() {
        return undefined as T;
      },
    },
    candidate: {
      get<T>() {
        return undefined as T;
      },
    },
  };
  return { first, all, options, create, unused, reset, dispose, verify, work, select };
}

describe("shared sequence measurement groups", () => {
  it("executes both variants once and preserves separate phase arrays and every metric ID", async () => {
    const input = groupedFixture();
    const results = await runPairedScenarios(input.options);
    expect(input.create).toHaveBeenCalledTimes(2);
    expect(input.unused).not.toHaveBeenCalled();
    expect(input.reset).toHaveBeenCalledTimes(2);
    expect(input.verify).toHaveBeenCalledTimes(2);
    expect(input.dispose).toHaveBeenCalledTimes(2);
    expect(input.work).toHaveBeenCalledTimes(6);
    expect(results.map((result) => [result.id, result.referenceMs, result.candidateMs])).toEqual([
      ["first", 2, 2],
      ["all", 9, 9],
    ]);
    expect(results[0]!.blocks[0]!.measurements[0]!.samplesMs).toEqual([2]);
    expect(results[1]!.blocks[0]!.measurements[0]!.samplesMs).toEqual([2, 3, 4]);
    expect(input.select.mock.calls).toEqual([
      ["final", "first"],
      ["final", "first"],
      ["final", "all"],
      ["final", "all"],
    ]);
  });

  it("keeps input result order when group members are interleaved with another workload", async () => {
    const input = groupedFixture();
    const separate = { ...input.first, id: "separate", measurementGroup: "another" };
    input.select.mockImplementation((_result, id) => [id === "separate" ? 5 : 2]);
    input.options.scenarios = [input.first, separate, input.all];
    const results = await runPairedScenarios(input.options);
    expect(results.map(({ id }) => id)).toEqual(["first", "separate", "all"]);
    expect(input.create).toHaveBeenCalledTimes(4);
    expect(input.work).toHaveBeenCalledTimes(12);
  });

  it.each([
    { modules: ["different"] },
    { execution: "async-sequence" as const },
    { sequenceLength: 4 },
    { warmupOperations: 1 },
  ])(
    "rejects conflicting workload metadata %j before constructing either variant",
    async (override) => {
      const input = groupedFixture();
      input.options.scenarios[1] = { ...input.all, ...override };
      await expect(runPairedScenarios(input.options)).rejects.toThrow("Mismatched");
      expect(input.create).not.toHaveBeenCalled();
    },
  );

  it.each(["sync", "async"] as const)("rejects grouped atomic %s execution", async (execution) => {
    const input = groupedFixture();
    input.options.scenarios = [{ ...input.first, execution }];
    await expect(runPairedScenarios(input.options)).rejects.toThrow(
      "Invalid comparison measurement group",
    );
    expect(input.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate scenario IDs even across different groups", () => {
    const input = groupedFixture();
    expect(() =>
      groupComparisonScenarios([input.first, { ...input.first, measurementGroup: "other" }]),
    ).toThrow("Duplicate");
  });

  it.each(["", "   "])("rejects empty group names %j", (measurementGroup) => {
    const input = groupedFixture();
    expect(() => groupComparisonScenarios([{ ...input.first, measurementGroup }])).toThrow(
      "Invalid comparison measurement group",
    );
  });

  it("fails an unknown phase and still disposes both shared kernels", async () => {
    const input = groupedFixture();
    input.options.scenarios[1] = { ...input.all, id: "unknown" };
    await expect(runPairedScenarios(input.options)).rejects.toThrow("Unknown metric: unknown");
    expect(input.dispose).toHaveBeenCalledTimes(2);
    expect(input.work).toHaveBeenCalledTimes(6);
  });

  it("fails missing phase samples instead of silently dropping the metric", async () => {
    const input = groupedFixture();
    input.select.mockImplementation((_result, id) => (id === "first" ? [2] : []));
    await expect(runPairedScenarios(input.options)).rejects.toThrow("invalid wall-clock");
    expect(input.dispose).toHaveBeenCalledTimes(2);
  });
});
