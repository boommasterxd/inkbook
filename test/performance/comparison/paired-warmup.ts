import type { ComparisonKernel, ComparisonSide } from "./contracts";
import { checkedSamples, isThenable, sumOperationWork } from "./paired-samples";

const TARGET_LIFECYCLE_MS = 250;
const MAXIMUM_OPERATIONS = 10_000;
interface Observation {
  workMs: number;
  lifecycleMs: number;
  samples: number;
}
export interface AtomicWarmup {
  initial: Record<ComparisonSide, Observation[]>;
  additional: Record<ComparisonSide, Observation[]>;
}

/** Choose one equal extension from initial reference cost, never from stability or candidate speed. */
export async function warmAtomicKernels(
  kernels: Record<ComparisonSide, ComparisonKernel>,
  initialOperations: number,
  measure: (kernel: ComparisonKernel) => readonly number[] | Promise<readonly number[]>,
): Promise<AtomicWarmup> {
  const warmup: AtomicWarmup = {
    initial: { reference: [], candidate: [] },
    additional: { reference: [], candidate: [] },
  };
  let totalOperations = initialOperations;
  for (let index = 0; index < totalOperations; index += 1) {
    const observations = index < initialOperations ? warmup.initial : warmup.additional;
    const order: readonly ComparisonSide[] =
      index % 2 === 0 ? ["reference", "candidate"] : ["candidate", "reference"];
    for (const side of order) {
      const start = performance.now();
      const pending = measure(kernels[side]);
      const samples = isThenable(pending) ? await pending : pending;
      const lifecycleMs = performance.now() - start;
      checkedSamples([lifecycleMs]);
      observations[side].push({
        workMs: sumOperationWork(samples),
        lifecycleMs,
        samples: samples.length,
      });
    }
    if (index + 1 === initialOperations) {
      const initialCost = sumOperationWork(
        warmup.initial.reference.map(({ lifecycleMs }) => lifecycleMs),
      );
      const meanCost = initialCost / initialOperations;
      const additional =
        initialCost >= TARGET_LIFECYCLE_MS
          ? 0
          : Math.ceil((TARGET_LIFECYCLE_MS - initialCost) / meanCost);
      totalOperations = Math.min(MAXIMUM_OPERATIONS, initialOperations + additional);
    }
  }
  return warmup;
}

export function warmupMetadata(warmup: AtomicWarmup) {
  const initialOperations = warmup.initial.reference.length;
  const additionalOperations = warmup.additional.reference.length;
  const cost = (side: ComparisonSide) =>
    sumOperationWork(
      [...warmup.initial[side], ...warmup.additional[side]].map(({ lifecycleMs }) => lifecycleMs),
    );
  return {
    targetLifecycleMs: TARGET_LIFECYCLE_MS,
    initialOperations,
    additionalOperations,
    maximumOperations: MAXIMUM_OPERATIONS,
    boundReached: initialOperations + additionalOperations === MAXIMUM_OPERATIONS,
    referenceLifecycleMs: cost("reference"),
    candidateLifecycleMs: cost("candidate"),
    targetReached: cost("reference") >= TARGET_LIFECYCLE_MS,
  };
}
