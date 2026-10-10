import type { WorkerTimingPort } from "../../../src/persistence/worker/runtime/worker-work-scheduler";
import { ManualTaskPort } from "../scheduling/manual-task-port";

export class ManualWorkerTiming extends ManualTaskPort implements WorkerTimingPort {
  public readonly setTimeout = this.setTimer;
  public readonly clearTimeout = this.clearTimer;
}
