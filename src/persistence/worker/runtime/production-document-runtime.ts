import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { ExecutorIdentity } from "../protocol";
import { DocumentWorkerRuntime } from "./document-runtime";
import { GestureAwareSliceScheduler } from "./slice-scheduler";

export interface ProductionRuntimeScheduling {
  readonly workScheduler: WorkScheduler;
  readonly updateSchedulingProfile?: (
    sliceMilliseconds: number,
    frameIntervalMilliseconds: number,
  ) => void;
}

export function createProductionDocumentRuntime(
  identity: ExecutorIdentity,
  scheduling: ProductionRuntimeScheduling,
): DocumentWorkerRuntime {
  const scheduler = new GestureAwareSliceScheduler({
    isInputActive: () => false,
    workScheduler: scheduling.workScheduler,
    ...(scheduling.updateSchedulingProfile === undefined
      ? {}
      : { updateSchedulingProfile: scheduling.updateSchedulingProfile }),
  });
  // This composition runs only behind the actual worker's transferred request channel.
  return new DocumentWorkerRuntime(identity, scheduler, undefined, true);
}
