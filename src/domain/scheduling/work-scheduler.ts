export const FRAME_WORK_SHARE = 0.55;

/** AbortSignal satisfies this structural contract without importing browser types. */
export interface FrameCancellation {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", callback: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", callback: () => void): void;
}

export type WorkPriority = "input" | "frame" | "background";

export class SchedulerDisposedError extends Error {
  public constructor() {
    super("Frame scheduler disposed.");
    this.name = "SchedulerDisposedError";
  }
}

/** Shared work admission for one owner window or document worker. */
export interface WorkScheduler {
  now(): number;
  deadline(): number;
  budgetMs(): number;
  shouldYield(): boolean;
  requestFrame(callback: (timestamp: number) => void, priority?: WorkPriority): number;
  cancelFrame(handle: number): void;
  checkpoint(signal?: FrameCancellation, priority?: WorkPriority): Promise<void> | undefined;
  nextFrame(signal?: FrameCancellation, priority?: WorkPriority): Promise<void>;
  dispose(): void;
}
