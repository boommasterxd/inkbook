import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComparisonScenario,
  ComparisonSide,
  ComparisonStatistic,
} from "../../../performance/comparison/contracts";
import { runPairedScenarios } from "../../../performance/comparison/paired-runner";

afterEach(() => vi.restoreAllMocks());

function samplingFixture(
  work: number,
  setup = 0,
  candidateWork = work,
  statistics: readonly ComparisonStatistic[] = [],
) {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const counts = { reference: 0, candidate: 0 };
  const scenario: ComparisonScenario = {
    id: "sampling",
    modules: [],
    covers: [],
    execution: "sync",
    warmupOperations: 2,
    statistics,
    create(impl) {
      const side = impl.get<ComparisonSide>("");
      return {
        reset() {
          clock += setup;
        },
        run() {
          counts[side] += 1;
          clock += side === "reference" ? work : candidateWork;
        },
        verify() {},
        dispose() {},
      };
    },
  };
  const implementation = (side: ComparisonSide) => ({ get: <T>() => side as T });
  return {
    counts,
    scenario,
    options: {
      scenarios: [scenario],
      reference: implementation("reference"),
      candidate: implementation("candidate"),
      refreshRate: 240,
    },
  };
}

describe("bounded reference-driven atomic sampling", () => {
  it.each([1, 5, 20, 101])(
    "targets 100 ms per group for %s ms operations with equal repetitions",
    async (work) => {
      const input = samplingFixture(work, 0, work * 4);
      const [result] = await runPairedScenarios(input.options);
      const repetitions = Math.ceil(100 / work);
      expect(result!.atomicSampling).toMatchObject({
        targetWorkMs: 100,
        maximumLifecycleMs: 250,
        operationsPerMeasurement: repetitions,
        referenceWarmupMeanMs: work,
        referenceLifecycleMeanMs: work,
        limits: [],
        estimatedTargetReached: true,
        measuredTargetReached: true,
      });
      expect(input.counts).toEqual({
        reference: Math.ceil(250 / work) + repetitions * 4,
        candidate: Math.ceil(250 / work) + repetitions * 4,
      });
      expect(result!.candidateMs / result!.referenceMs).toBe(4);
      expect(result!.blocks).toHaveLength(2);
      for (const measurement of result!.blocks.flatMap(({ measurements }) => measurements)) {
        expect(measurement.samplesMs).toHaveLength(repetitions);
        expect(measurement.operationWorkMs).toHaveLength(repetitions);
        expect(measurement.operationSampleCounts).toEqual(Array(repetitions).fill(1));
      }
    },
  );

  it("caps tiny decisions with expensive resets using complete reference lifecycle cost", async () => {
    const input = samplingFixture(0.001, 100);
    const [result] = await runPairedScenarios(input.options);
    expect(result!.atomicSampling).toMatchObject({
      operationsPerMeasurement: 2,
      limits: ["operation-count", "lifecycle-cost"],
      estimatedTargetReached: false,
      measuredTargetReached: false,
    });
    expect(result!.atomicSampling!.referenceLifecycleMeanMs).toBeCloseTo(100.001);
    expect(input.counts).toEqual({ reference: 11, candidate: 11 });
  });

  it("keeps at least one operation when setup alone exceeds the estimate cap", async () => {
    const input = samplingFixture(1, 1000);
    const [result] = await runPairedScenarios(input.options);
    expect(result!.atomicSampling!.operationsPerMeasurement).toBe(1);
    expect(result!.atomicSampling!.limits).toEqual(["lifecycle-cost"]);
    expect(input.counts).toEqual({ reference: 6, candidate: 6 });
  });

  it("bounds a zero-resolution clock without retrying until nonzero or passing", async () => {
    const input = samplingFixture(0);
    const [result] = await runPairedScenarios(input.options);
    expect(result!.atomicSampling).toMatchObject({
      operationsPerMeasurement: 10_000,
      limits: ["operation-count"],
      estimatedTargetReached: false,
      measuredTargetReached: false,
    });
    expect(input.counts).toEqual({ reference: 50_000, candidate: 50_000 });
    expect(result!.referenceMs).toBe(0);
  });

  it("reports progress outside work and propagates an operation error", async () => {
    const input = samplingFixture(10);
    const onProgress =
      vi.fn<(event: { phase: "start" | "end" | "error"; ids: string[] }) => void>();
    await runPairedScenarios({ ...input.options, onProgress });
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
      { phase: "start", ids: ["sampling"] },
      { phase: "end", ids: ["sampling"] },
    ]);
    onProgress.mockClear();
    input.scenario.create = () => ({
      run() {
        throw new Error("broken");
      },
      verify() {},
      dispose() {},
    });
    await expect(runPairedScenarios({ ...input.options, onProgress })).rejects.toThrow("broken");
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
      { phase: "start", ids: ["sampling"] },
      { phase: "error", ids: ["sampling"] },
    ]);
  });
});

describe("fixed warmup extension and contractual populations", () => {
  it("reports initial and additional equal warmups plus both achieved lifecycle costs", async () => {
    const input = samplingFixture(10, 0, 20);
    const [result] = await runPairedScenarios(input.options);
    expect(result!.atomicSampling!.warmup).toEqual({
      targetLifecycleMs: 250,
      initialOperations: 2,
      additionalOperations: 23,
      maximumOperations: 10_000,
      boundReached: false,
      referenceLifecycleMs: 250,
      candidateLifecycleMs: 500,
      targetReached: true,
    });
  });

  it("recalibrates from the fixed additional stage without extending again when work gets faster", async () => {
    const input = samplingFixture(10);
    const create = input.scenario.create.bind(input.scenario);
    input.scenario.create = async (impl, hz) => {
      const kernel = await create(impl, hz);
      const run = kernel.run.bind(kernel);
      let operation = 0;
      kernel.run = () => {
        operation += 1;
        return run();
      };
      kernel.measurementSamples = () => [operation <= 2 ? 10 : 1];
      return kernel;
    };
    const [result] = await runPairedScenarios(input.options);
    expect(result!.atomicSampling).toMatchObject({
      referenceWarmupMeanMs: 1,
      referenceLifecycleMeanMs: 10,
      operationsPerMeasurement: 25,
      warmup: { initialOperations: 2, additionalOperations: 23 },
      limits: ["lifecycle-cost"],
    });
    expect(input.counts).toEqual({ reference: 125, candidate: 125 });
  });

  it.each([
    { kind: "p95", population: "samples", minimumSamples: 100 },
    { kind: "p95", population: "operations", minimumSamples: 100 },
    { kind: "mean", population: "samples", minimumOperations: 100 },
  ] as const)(
    "enforces original population beyond the estimated lifecycle budget: %j",
    async (statistic) => {
      const input = samplingFixture(1, 1000, 1, [statistic]);
      const [result] = await runPairedScenarios(input.options);
      expect(result!.atomicSampling).toMatchObject({
        operationsPerMeasurement: 25,
        minimumOperationsPerMeasurement: 25,
        limits: ["lifecycle-cost", "minimum-population"],
      });
      expect(input.counts).toEqual({ reference: 102, candidate: 102 });
    },
  );

  it("uses observed inner sample count and preserves explicit max fallback", async () => {
    const input = samplingFixture(1, 1000, 1, [
      { kind: "p95", population: "samples", minimumSamples: 100 },
    ]);
    const create = input.scenario.create.bind(input.scenario);
    input.scenario.create = async (impl, hz) => ({
      ...(await create(impl, hz)),
      measurementSamples: () => [0.5, 0.5],
    });
    const [result] = await runPairedScenarios(input.options);
    expect(result!.atomicSampling!.minimumOperationsPerMeasurement).toBe(13);
    const fallback = samplingFixture(1, 1000, 1, [
      { kind: "p99", population: "samples", minimumSamples: 100, fallback: "max" },
    ]);
    const [fallbackResult] = await runPairedScenarios(fallback.options);
    expect(fallbackResult!.atomicSampling!.minimumOperationsPerMeasurement).toBe(1);
  });

  it("fails impossible or invalid population rather than silently weakening it", async () => {
    for (const minimumOperations of [40_001, -1, 1.5]) {
      const input = samplingFixture(1000, 0, 1000, [
        { kind: "mean", population: "operations", minimumOperations },
      ]);
      await expect(runPairedScenarios(input.options)).rejects.toThrow("minimum population");
    }
  });
});
