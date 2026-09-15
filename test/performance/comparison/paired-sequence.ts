import type {
  ComparisonKernel,
  ComparisonScenario,
  ComparisonSide,
  PairedMeasurement,
  PairedScenarioResult,
} from "./contracts";
import { checkedSamples, isThenable, sumOperationWork } from "./paired-samples";

type SequenceIterator = Iterator<void, unknown, void> | AsyncIterator<void, unknown, void>;
type Step = IteratorResult<void, unknown>;

declare const gc: (() => void) | undefined;

export function validateSequence(scenario: ComparisonScenario): void {
  if (
    !Number.isSafeInteger(scenario.sequenceLength) ||
    scenario.sequenceLength! < 1 ||
    scenario.sequenceLength! > 1_000_000
  ) {
    throw new Error(`Invalid comparison sequence length: ${scenario.id}`);
  }
}

export async function runPairedSequence(
  scenario: ComparisonScenario,
  kernels: Record<ComparisonSide, ComparisonKernel>,
  refreshRate: number,
  metrics: readonly ComparisonScenario[] = [scenario],
  roundIndex = 0,
): Promise<PairedScenarioResult[]> {
  const iterators: Partial<Record<ComparisonSide, SequenceIterator>> = {};
  try {
    for (const side of sequenceStepOrder(roundIndex)) {
      if (!kernels[side].measurementSamples)
        throw new Error("Sequence kernels require real measurement samples.");
      await kernels[side].reset?.();
      iterators[side] = requireIterator(kernels[side].run());
    }
    // Release preparation garbage before either trajectory contributes timing samples.
    if (typeof gc === "function") gc();
    const final = await consumeSequence(
      iterators as Record<ComparisonSide, SequenceIterator>,
      scenario,
      roundIndex,
    );
    for (const side of ["reference", "candidate"] as const) {
      await kernels[side].verify(final[side]);
    }
    return metrics.map((metric) =>
      sequenceMeasurement(metric, kernels, final, { refreshRate, roundIndex }),
    );
  } finally {
    try {
      await iterators.candidate?.return?.();
    } finally {
      await iterators.reference?.return?.();
    }
  }
}

function sequenceMeasurement(
  metric: ComparisonScenario,
  kernels: Record<ComparisonSide, ComparisonKernel>,
  final: Record<ComparisonSide, unknown>,
  options: { refreshRate: number; roundIndex: number },
): PairedScenarioResult {
  const measurements: PairedMeasurement[] = [];
  for (const side of ["reference", "candidate"] as const) {
    const kernel = kernels[side];
    const samples =
      metric.measurementGroup === undefined
        ? kernel.measurementSamples!(final[side])
        : kernel.measurementSamples!(final[side], metric.id);
    const samplesMs = [...checkedSamples(samples)];
    const workMs = sumOperationWork(samplesMs);
    measurements.push({
      side,
      samplesMs,
      operationWorkMs: [workMs],
      operationSampleCounts: [samplesMs.length],
      meanMs: workMs,
    });
  }
  const referenceMs = measurements[0]!.meanMs;
  const candidateMs = measurements[1]!.meanMs;
  return {
    id: metric.id,
    refreshRate: options.refreshRate,
    measurementKind: "paired-sequence-work",
    ...(metric.statistics === undefined ? {} : { statistics: metric.statistics }),
    sequenceLength: metric.sequenceLength!,
    sequenceOrder: options.roundIndex % 2 === 0 ? "alternating-ab-ba" : "alternating-ba-ab",
    blocks: [{ measurements, referenceMs, candidateMs }],
    referenceMs,
    candidateMs,
  };
}

async function consumeSequence(
  iterators: Record<ComparisonSide, SequenceIterator>,
  scenario: ComparisonScenario,
  roundIndex: number,
): Promise<Record<ComparisonSide, unknown>> {
  for (let step = 0; step <= scenario.sequenceLength!; step += 1) {
    const order = sequenceStepOrder(step + roundIndex);
    const results: Partial<Record<ComparisonSide, Step>> = {};
    for (const side of order) {
      const pending = iterators[side].next();
      if (scenario.execution === "sequence" && isThenable(pending)) {
        void Promise.resolve(pending).catch(() => undefined);
        throw new Error("Synchronous sequence returned an asynchronous step.");
      }
      results[side] = requireStep(isThenable(pending) ? await pending : pending);
    }
    const reference = results.reference!;
    const candidate = results.candidate!;
    if (reference.done !== candidate.done)
      throw new Error("Paired sequences completed at different steps.");
    if (reference.done) {
      if (step !== scenario.sequenceLength)
        throw new Error("Paired sequences ended before the required length.");
      return { reference: reference.value, candidate: candidate.value };
    }
    if (step === scenario.sequenceLength)
      throw new Error("Paired sequence exceeded its required length.");
  }
  throw new Error("Unreachable sequence state.");
}

function requireIterator(value: unknown): SequenceIterator {
  if (
    !value ||
    typeof value !== "object" ||
    !("next" in value) ||
    typeof value.next !== "function"
  ) {
    throw new Error("Sequence kernel must return an iterator.");
  }
  return value as SequenceIterator;
}

function requireStep(value: unknown): Step {
  if (
    !value ||
    typeof value !== "object" ||
    !("done" in value) ||
    typeof value.done !== "boolean" ||
    !("value" in value)
  ) {
    throw new Error("Sequence returned an invalid iterator step.");
  }
  if (!value.done && value.value !== undefined)
    throw new Error("Sequence yields must not carry a value.");
  return value as Step;
}

function sequenceStepOrder(index: number): readonly ComparisonSide[] {
  return index % 2 === 0 ? ["reference", "candidate"] : ["candidate", "reference"];
}
