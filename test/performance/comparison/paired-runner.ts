import type {
  AtomicSampling,
  ComparisonImplementation,
  ComparisonKernel,
  ComparisonScenario,
  ComparisonSide as Side,
  PairedMeasurement as Measurement,
  PairedBlock as Block,
  PairedScenarioResult,
} from "./contracts";
import { runPairedSequence, validateSequence } from "./paired-sequence";
import { checkedSamples, isThenable, sumOperationWork } from "./paired-samples";

import { warmAtomicKernels, warmupMetadata, type AtomicWarmup } from "./paired-warmup";

import { groupComparisonScenarios } from "./paired-groups";

declare const gc: (() => void) | undefined;

const BLOCK_COUNT = 2;
const TARGET_WORK_MS = 100;
const MAXIMUM_LIFECYCLE_MS = 250;
const MAXIMUM_OPERATIONS = 10_000;
const MAXIMUM_SAMPLES = 1_000_000;

export type { PairedScenarioResult } from "./contracts";
interface RunOptions {
  scenarios: readonly ComparisonScenario[];
  reference: ComparisonImplementation;
  candidate: ComparisonImplementation;
  refreshRate: number;
  /** Fresh-process round, used to counterbalance sequence setup and first-step order. */
  roundIndex?: number;
  onProgress?(event: { phase: "start" | "end" | "error"; ids: string[] }): void;
}

export async function runPairedScenarios(options: RunOptions): Promise<PairedScenarioResult[]> {
  const roundIndex = options.roundIndex ?? 0;
  if (!Number.isSafeInteger(roundIndex) || roundIndex < 0 || roundIndex > 2)
    throw new Error("Invalid comparison round index.");
  const results = new Map<string, PairedScenarioResult>();
  for (const metrics of groupComparisonScenarios(options.scenarios)) {
    const ids = metrics.map(({ id }) => id);
    options.onProgress?.({ phase: "start", ids });
    try {
      for (const result of await runScenario(metrics[0]!, options, metrics)) {
        results.set(result.id, result);
      }
      options.onProgress?.({ phase: "end", ids });
    } catch (error) {
      options.onProgress?.({ phase: "error", ids });
      throw error;
    }
  }
  return options.scenarios.map((scenario) => results.get(scenario.id)!);
}

async function runScenario(
  scenario: ComparisonScenario,
  options: RunOptions,
  metrics: readonly ComparisonScenario[],
): Promise<PairedScenarioResult[]> {
  validateScenario(scenario);
  const reference = await scenario.create(options.reference, options.refreshRate);
  let candidate: ComparisonKernel | undefined;
  try {
    candidate = await scenario.create(options.candidate, options.refreshRate);
    const kernels = { reference, candidate };
    if (scenario.execution === "sequence" || scenario.execution === "async-sequence") {
      return await runPairedSequence(
        scenario,
        kernels,
        options.refreshRate,
        metrics,
        options.roundIndex,
      );
    }
    const warmup = await warmAtomicKernels(kernels, scenario.warmupOperations, (kernel) =>
      measureOperation(kernel, scenario.execution),
    );
    const atomicSampling = calibrateSampling(warmup, scenario);
    const blocks: Block[] = [];
    for (let index = 0; index < BLOCK_COUNT; index += 1) {
      if (typeof gc === "function") gc();
      blocks.push(
        await measureBlock(kernels, scenario, index, atomicSampling.operationsPerMeasurement),
      );
    }
    atomicSampling.measuredTargetReached = blocks.every((block) =>
      block.measurements
        .filter(({ side }) => side === "reference")
        .every(({ operationWorkMs }) => sumOperationWork(operationWorkMs) >= TARGET_WORK_MS),
    );
    return [
      {
        id: scenario.id,
        refreshRate: options.refreshRate,
        measurementKind: "mean-operation-work",
        ...(scenario.statistics === undefined ? {} : { statistics: scenario.statistics }),
        atomicSampling,
        blocks,
        referenceMs: mean(blocks.map((block) => block.referenceMs)),
        candidateMs: mean(blocks.map((block) => block.candidateMs)),
      },
    ];
  } finally {
    try {
      await candidate?.dispose();
    } finally {
      await reference.dispose();
    }
  }
}

async function measureBlock(
  kernels: Record<Side, ComparisonKernel>,
  scenario: ComparisonScenario,
  index: number,
  operations: number,
): Promise<Block> {
  const order: Side[] =
    index % 2 === 0
      ? ["reference", "candidate", "candidate", "reference"]
      : ["candidate", "reference", "reference", "candidate"];
  const measurements: Measurement[] = [];
  for (const side of order) {
    const samplesMs: number[] = [];
    const operationWorkMs: number[] = [];
    const operationSampleCounts: number[] = [];
    for (let operation = 0; operation < operations; operation += 1) {
      const operationResult = measureOperation(kernels[side], scenario.execution);
      const samples = isThenable(operationResult) ? await operationResult : operationResult;
      if (samplesMs.length + samples.length > MAXIMUM_SAMPLES) {
        throw new Error(`Measurement sample bound exceeded: ${scenario.id}`);
      }
      const workMs = sumOperationWork(samples);
      operationWorkMs.push(workMs);
      operationSampleCounts.push(samples.length);
      for (const sample of samples) samplesMs.push(sample);
    }
    measurements.push({
      side,
      samplesMs,
      operationWorkMs,
      operationSampleCounts,
      meanMs: mean(operationWorkMs),
    });
  }
  return {
    measurements,
    referenceMs: mean(
      measurements.filter((item) => item.side === "reference").map((item) => item.meanMs),
    ),
    candidateMs: mean(
      measurements.filter((item) => item.side === "candidate").map((item) => item.meanMs),
    ),
  };
}

function measureOperation(
  kernel: ComparisonKernel,
  execution: ComparisonScenario["execution"],
): readonly number[] | Promise<readonly number[]> {
  const reset = kernel.reset?.();
  return isThenable(reset)
    ? Promise.resolve(reset).then(() => measureRun(kernel, execution))
    : measureRun(kernel, execution);
}

function measureRun(
  kernel: ComparisonKernel,
  execution: ComparisonScenario["execution"],
): readonly number[] | Promise<readonly number[]> {
  const start = performance.now();
  const result = kernel.run();
  if (execution === "async") {
    return Promise.resolve(result).then((value) =>
      verifyMeasurement(kernel, value, performance.now() - start),
    );
  }
  const elapsed = performance.now() - start;
  if (isThenable(result)) {
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("Synchronous comparison kernel returned a promise.");
  }
  return verifyMeasurement(kernel, result, elapsed);
}

function verifyMeasurement(
  kernel: ComparisonKernel,
  result: unknown,
  elapsed: number,
): readonly number[] | Promise<readonly number[]> {
  const verification = kernel.verify(result);
  return isThenable(verification)
    ? Promise.resolve(verification).then(() => measurementSamples(kernel, result, elapsed))
    : measurementSamples(kernel, result, elapsed);
}

function measurementSamples(
  kernel: ComparisonKernel,
  result: unknown,
  elapsed: number,
): readonly number[] {
  return checkedSamples(kernel.measurementSamples?.(result) ?? [elapsed]);
}

function mean(values: readonly number[]): number {
  return sumOperationWork(values) / values.length;
}

function validateScenario(scenario: ComparisonScenario): void {
  if (scenario.execution === "sequence" || scenario.execution === "async-sequence") {
    validateSequence(scenario);
    return;
  }
  for (const count of [scenario.warmupOperations]) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new Error(`Invalid comparison operation count: ${scenario.id}`);
    }
  }
}

function calibrateSampling(warmup: AtomicWarmup, scenario: ComparisonScenario): AtomicSampling {
  const calibration =
    warmup.additional.reference.length > 0 ? warmup.additional.reference : warmup.initial.reference;
  const referenceWarmupMeanMs = mean(calibration.map(({ workMs }) => workMs));
  const referenceLifecycleMeanMs = mean(calibration.map(({ lifecycleMs }) => lifecycleMs));
  const requested = Math.max(1, Math.ceil(TARGET_WORK_MS / referenceWarmupMeanMs));
  const lifecycleLimit = Math.max(1, Math.floor(MAXIMUM_LIFECYCLE_MS / referenceLifecycleMeanMs));
  const samplesPerOperation = Math.min(
    ...Object.values(warmup.initial).flatMap((observations) =>
      observations.map(({ samples }) => samples),
    ),
  );
  const minimumOperationsPerMeasurement = minimumRepetitions(scenario, samplesPerOperation);
  if (minimumOperationsPerMeasurement > MAXIMUM_OPERATIONS)
    throw new Error("Comparison minimum population exceeds the operation bound.");
  const budgeted = Math.min(requested, lifecycleLimit, MAXIMUM_OPERATIONS);
  const operationsPerMeasurement = Math.max(budgeted, minimumOperationsPerMeasurement);
  const limits: AtomicSampling["limits"] = [];
  if (requested > MAXIMUM_OPERATIONS) limits.push("operation-count");
  if (requested > lifecycleLimit) limits.push("lifecycle-cost");
  if (minimumOperationsPerMeasurement > budgeted) limits.push("minimum-population");
  return {
    targetWorkMs: TARGET_WORK_MS,
    maximumLifecycleMs: MAXIMUM_LIFECYCLE_MS,
    referenceWarmupMeanMs,
    referenceLifecycleMeanMs,
    operationsPerMeasurement,
    maximumOperations: MAXIMUM_OPERATIONS,
    minimumOperationsPerMeasurement,
    warmup: warmupMetadata(warmup),
    limits,
    estimatedTargetReached: operationsPerMeasurement * referenceWarmupMeanMs >= TARGET_WORK_MS,
    measuredTargetReached: false,
  };
}

function minimumRepetitions(scenario: ComparisonScenario, samplesPerOperation: number): number {
  let required = 1;
  for (const statistic of scenario.statistics ?? []) {
    const samples = statistic.fallback === "max" ? 0 : (statistic.minimumSamples ?? 0);
    const operations = statistic.minimumOperations ?? 0;
    if (![samples, operations].every((count) => Number.isSafeInteger(count) && count >= 0))
      throw new Error("Invalid comparison minimum population.");
    const perOperation = statistic.population === "operations" ? 1 : samplesPerOperation;
    required = Math.max(
      required,
      Math.ceil(samples / (4 * perOperation)),
      Math.ceil(operations / 4),
    );
  }
  return required;
}
