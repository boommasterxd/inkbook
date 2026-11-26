import type {
  FrameCancellation,
  WorkScheduler,
} from "../../../src/domain/scheduling/work-scheduler";

export interface TestWorkSchedulerOptions {
  readonly budgetMs?: number | (() => number);
  readonly now?: () => number;
  readonly shouldYield?: () => boolean;
  readonly checkpoint?: (signal?: FrameCancellation) => Promise<void> | undefined;
  readonly nextFrame?: (signal?: FrameCancellation) => Promise<void>;
}

/** Deterministic scheduler boundary for persistence tests. */
export class TestWorkScheduler implements WorkScheduler {
  readonly #options: TestWorkSchedulerOptions;

  public constructor(options: TestWorkSchedulerOptions = {}) {
    this.#options = options;
  }

  public now(): number {
    return this.#options.now?.() ?? 0;
  }

  public deadline(): number {
    return this.now() + this.budgetMs();
  }

  public budgetMs(): number {
    const budget = this.#options.budgetMs ?? 8;
    return typeof budget === "function" ? budget() : budget;
  }

  public shouldYield(): boolean {
    return this.#options.shouldYield?.() ?? false;
  }

  public requestFrame(callback: (timestamp: number) => void): number {
    callback(this.now());
    return 0;
  }

  public cancelFrame(_handle: number): void {}

  public checkpoint(signal?: FrameCancellation): Promise<void> | undefined {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return this.#options.checkpoint?.(signal);
  }

  public nextFrame(signal?: FrameCancellation): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return this.#options.nextFrame?.(signal) ?? Promise.resolve();
  }

  public dispose(): void {}
}

export function createTestWorkScheduler(options: TestWorkSchedulerOptions = {}): WorkScheduler {
  return new TestWorkScheduler(options);
}

function abortReason(signal: FrameCancellation): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Test scheduler aborted.");
}
