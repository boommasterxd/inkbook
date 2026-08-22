import type { ExecutorIdentity } from "../protocol";
import { DocumentWorkerRuntime } from "./document-runtime";
import { GestureAwareSliceScheduler } from "./slice-scheduler";

export interface ProductionRuntimeScheduling {
  readonly now?: () => number;
  readonly yieldControl: () => Promise<void>;
}

export function createProductionDocumentRuntime(
  identity: ExecutorIdentity,
  scheduling: ProductionRuntimeScheduling,
): DocumentWorkerRuntime {
  const scheduler = new GestureAwareSliceScheduler({
    isInputActive: () => false,
    ...(scheduling.now === undefined ? {} : { now: scheduling.now }),
    yieldControl: scheduling.yieldControl,
  });
  return new DocumentWorkerRuntime(identity, scheduler);
}
