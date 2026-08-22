export interface MemoryCheckpoint {
  readonly bytes: number;
  readonly phase: string;
  readonly run: number;
}

export interface ReleasedInstrumentation {
  readonly cacheBytes: number;
  readonly cacheElements: number;
  readonly prewarmedBytes: number;
  readonly prewarmedElements: number;
  readonly retainedCompleteOutputBytes: number;
  readonly unacknowledgedExports: number;
}

export interface MemoryResult {
  readonly cacheBytes: number;
  readonly cacheElements: number;
  readonly checkpoints: readonly MemoryCheckpoint[];
  readonly coalescedCommitsPerRun: number;
  readonly lifecycleRuns: number;
  readonly outputBytes: number;
  readonly peakBytes: number;
  readonly releasedInstrumentation: readonly ReleasedInstrumentation[];
  readonly retainedBytes: readonly number[];
}
