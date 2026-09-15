export interface ComparisonImplementation {
  get<T>(sourceModule: string): T;
}

export interface ComparisonKernel {
  /** Prepare the next identical operation outside the measured interval. */
  reset?(): void | Promise<void>;
  run(): unknown;
  verify(result: unknown): void | Promise<void>;
  /** Real measured intervals for a specific internal phase, using its original wall/CPU clock;
   * never modeled scheduler time.
   * The driver retains all intervals, sums their work per operation, and compares mean
   * operation work alongside the explicitly declared original latency statistics.
   * Grouped kernels must select the requested scenario ID and reject unknown IDs.
   */
  measurementSamples?(result: unknown, metricId?: string): readonly number[];
  dispose(): void | Promise<void>;
}

export interface TimingCoverage {
  readonly file: string;
  /** Exact title or a stable substring of the existing timing assertion's test name. */
  readonly test: string;
  /** Omit only if the scenario truly measures every timing phase in that test. */
  readonly ordinals?: readonly number[];
}

export interface ComparisonStatistic {
  readonly kind: "p50" | "p95" | "p99" | "max" | "total" | "mean";
  readonly population: "samples" | "operations";
  readonly estimator?: "nearest-rank" | "upper-rank";
  readonly aggregation?: "worst-window";
  readonly windowSize?: number;
  readonly minimumSamples?: number;
  readonly minimumOperations?: number;
  readonly fallback?: "max";
}

export interface ComparisonScenario {
  readonly id: string;
  readonly modules: readonly string[];
  readonly covers: readonly TimingCoverage[];
  readonly statistics?: readonly ComparisonStatistic[];
  readonly execution: "sync" | "async" | "sequence" | "async-sequence";
  /** Required for sequence modes: exact number of yielded matched steps before return.
   * Sequence run() returns a generator; measurementSamples(finalResult) retains real intervals.
   * Atomic warmups are unused for sequences, which execute once per round.
   */
  readonly sequenceLength?: number;
  /** Share one sequence workload; every member must collect all group phases. */
  readonly measurementGroup?: string;
  readonly warmupOperations: number;
  create(
    implementation: ComparisonImplementation,
    refreshRate: number,
  ): ComparisonKernel | Promise<ComparisonKernel>;
}

export type ComparisonSide = "reference" | "candidate";

export interface PairedMeasurement {
  side: ComparisonSide;
  samplesMs: number[];
  operationWorkMs: number[];
  operationSampleCounts: number[];
  meanMs: number;
}

export interface PairedBlock {
  measurements: PairedMeasurement[];
  referenceMs: number;
  candidateMs: number;
}

export interface AtomicSampling {
  targetWorkMs: number;
  maximumLifecycleMs: number;
  referenceWarmupMeanMs: number;
  referenceLifecycleMeanMs: number;
  operationsPerMeasurement: number;
  maximumOperations: number;
  limits: ("operation-count" | "lifecycle-cost" | "minimum-population")[];
  minimumOperationsPerMeasurement: number;
  warmup: {
    targetLifecycleMs: number;
    initialOperations: number;
    additionalOperations: number;
    maximumOperations: number;
    boundReached: boolean;
    referenceLifecycleMs: number;
    candidateLifecycleMs: number;
    targetReached: boolean;
  };
  estimatedTargetReached: boolean;
  measuredTargetReached: boolean;
}

export interface PairedScenarioResult {
  id: string;
  statistics?: readonly ComparisonStatistic[];
  refreshRate: number;
  measurementKind: "mean-operation-work" | "paired-sequence-work";
  atomicSampling?: AtomicSampling;
  blocks: PairedBlock[];
  referenceMs: number;
  candidateMs: number;
  sequenceLength?: number;
  sequenceOrder?: "alternating-ab-ba" | "alternating-ba-ab";
}
