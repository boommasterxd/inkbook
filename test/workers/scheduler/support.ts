import type { WorkerSliceMode } from "../../../src/workers/scheduler/protocol";
import type { WorkerSliceScheduler } from "../../../src/workers/scheduler/scheduler";

export class ManualSlices implements WorkerSliceScheduler {
  public readonly modes: WorkerSliceMode[] = [];
  private readonly callbacks: { cancelled: boolean; run: () => void }[] = [];

  public schedule(mode: WorkerSliceMode, callback: () => void): () => void {
    this.modes.push(mode);
    const item = { cancelled: false, run: callback };
    this.callbacks.push(item);
    return (): void => {
      item.cancelled = true;
    };
  }

  public flushOne(): void {
    const item = this.callbacks.shift();
    if (item !== undefined && !item.cancelled) item.run();
  }

  public flushAll(): void {
    while (this.callbacks.length > 0) this.flushOne();
  }
}
