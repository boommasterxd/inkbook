import type {
  RecoveryAttemptId,
  SaveGeneration,
  SourceCheckpointId,
} from "../note-session";
import type { SaveGenerationRequestV1 } from "./save-pipeline";

export const SAVE_IDLE_DEBOUNCE_MS_V1 = 150;
export const SAVE_MAX_DIRTY_MS_V1 = 2_000;

export interface SaveStartClockV1 {
  readonly nowEpochMs: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (timer: unknown) => void;
}

export type SaveStartScheduleResultV1 =
  "disposed" | "rejected" | "replaced" | "scheduled";

interface ScheduledSave<TSnapshot> extends SaveGenerationRequestV1<TSnapshot> {
  coveredAttemptIds: RecoveryAttemptId[];
  coveredCheckpointIds: SourceCheckpointId[];
}

type RecoveryCoverageV1 = Pick<
  SaveGenerationRequestV1<unknown>,
  "coveredAttemptIds" | "coveredCheckpointIds"
>;

export class SaveStartScheduler<TSnapshot> {
  private pending: ScheduledSave<TSnapshot> | null = null;
  private timer: unknown = null;
  private firstDirtyAt: number | null = null;
  private latestGeneration: SaveGeneration | null = null;
  private carried: RecoveryCoverageV1 | null = null;
  private retryable: ScheduledSave<TSnapshot> | null = null;
  private disposed = false;

  constructor(
    private readonly clock: SaveStartClockV1,
    private readonly start: (
      request: SaveGenerationRequestV1<TSnapshot>,
    ) => void,
  ) {}

  markDirty(
    request: SaveGenerationRequestV1<TSnapshot>,
  ): SaveStartScheduleResultV1 {
    if (this.disposed) return "disposed";
    if (
      this.latestGeneration !== null &&
      request.generation <= this.latestGeneration
    ) {
      return "rejected";
    }
    this.latestGeneration = request.generation;
    this.retryable = null;
    const replacement: ScheduledSave<TSnapshot> = {
      ...request,
      coveredAttemptIds: [...request.coveredAttemptIds],
      coveredCheckpointIds: [...request.coveredCheckpointIds],
    };
    mergeCoverage(replacement, this.carried);
    this.carried = null;
    const result = this.pending === null ? "scheduled" : "replaced";
    if (this.pending === null) this.firstDirtyAt = this.clock.nowEpochMs();
    else mergeCoverage(replacement, this.pending);
    this.pending = replacement;
    this.arm();
    return result;
  }

  forceFlush(): boolean {
    if (this.pending === null || this.disposed) return false;
    this.dispatch(this.pending);
    return true;
  }

  retainForRetry(request: SaveGenerationRequestV1<TSnapshot>): boolean {
    if (
      this.disposed ||
      this.pending !== null ||
      request.generation !== this.latestGeneration
    ) {
      return false;
    }
    this.retryable = {
      ...request,
      coveredAttemptIds: [...request.coveredAttemptIds],
      coveredCheckpointIds: [...request.coveredCheckpointIds],
    };
    return true;
  }

  retry(): boolean {
    if (this.disposed || this.pending !== null || this.retryable === null) {
      return false;
    }
    const retryable = this.retryable;
    this.retryable = null;
    this.start(retryable);
    return true;
  }

  cancel(generation: SaveGeneration): boolean {
    if (this.pending?.generation !== generation) return false;
    const pending = this.pending;
    this.clearTimer();
    const carried = { coveredAttemptIds: [], coveredCheckpointIds: [] };
    mergeCoverage(carried, this.carried);
    mergeCoverage(carried, pending);
    this.carried = carried;
    this.pending = null;
    this.firstDirtyAt = null;
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer();
    this.pending = null;
    this.firstDirtyAt = null;
    this.carried = null;
    this.retryable = null;
  }

  private arm(): void {
    this.clearTimer();
    const now = this.clock.nowEpochMs();
    const maximum = (this.firstDirtyAt ?? now) + SAVE_MAX_DIRTY_MS_V1;
    const target = Math.min(now + SAVE_IDLE_DEBOUNCE_MS_V1, maximum);
    this.timer = this.clock.schedule(() => {
      this.timer = null;
      if (this.pending !== null) this.dispatch(this.pending);
    }, target - now);
  }

  private dispatch(pending: ScheduledSave<TSnapshot>): void {
    this.clearTimer();
    this.pending = null;
    this.firstDirtyAt = null;
    this.start(pending);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.cancel(this.timer);
    this.timer = null;
  }
}

function mergeCoverage(
  target: {
    coveredAttemptIds: RecoveryAttemptId[];
    coveredCheckpointIds: SourceCheckpointId[];
  },
  prior: RecoveryCoverageV1 | null,
): void {
  if (prior === null) return;
  target.coveredAttemptIds = mergeIds(
    prior.coveredAttemptIds,
    target.coveredAttemptIds,
  );
  target.coveredCheckpointIds = mergeIds(
    prior.coveredCheckpointIds,
    target.coveredCheckpointIds,
  );
}

function mergeIds<T>(prior: readonly T[], latest: readonly T[]): T[] {
  return [...new Set([...prior, ...latest])];
}
