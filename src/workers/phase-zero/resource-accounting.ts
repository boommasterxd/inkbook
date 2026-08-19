import {
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type BatchResourceHandleV1,
  type ResourceAdmissionRequestV1,
  type ResourceCategoryV1,
  type ResourceScopeV1,
} from "../../application/resource-coordinator";
import { PHASE_ZERO_CHUNK_BYTES } from "./protocol";

const WORKER_LISTENER_COUNT = 3;

export interface WorkerResourceContext {
  readonly coordinator: ResourceCoordinatorV1;
  readonly ownerId: string;
  readonly scope: ResourceScopeV1;
}

export interface PhaseZeroOwnedResult extends Uint8Array<ArrayBuffer> {
  release(): boolean;
}

export function createWorkerResourceContext(
  coordinator: ResourceCoordinatorV1,
  ownerId: string,
): WorkerResourceContext {
  return {
    coordinator,
    ownerId,
    scope: { id: ownerId, kind: "session" },
  };
}

export class WorkerOwnerResources {
  private constructor(private readonly handle: BatchResourceHandleV1) {}

  public static admit(
    context: WorkerResourceContext,
  ): WorkerOwnerResources | undefined {
    const result = context.coordinator.admitBatch({
      operations: [
        request(
          context,
          RESOURCE_CATEGORIES_V1.workerOwner,
          context.ownerId,
          1,
          0,
        ),
        request(
          context,
          RESOURCE_CATEGORIES_V1.listener,
          context.ownerId,
          WORKER_LISTENER_COUNT,
          0,
        ),
      ],
    });
    if (result.kind !== "admitted") return undefined;
    if (!result.handle.activate()) {
      result.handle.release();
      return undefined;
    }
    return new WorkerOwnerResources(result.handle);
  }

  public release(): void {
    this.handle.release();
  }
}

export class WorkerTaskResources {
  #completionPublished = false;

  private constructor(private readonly handle: BatchResourceHandleV1) {}

  public static admit(
    context: WorkerResourceContext,
    taskId: number,
    bytes: number,
    scope: ResourceScopeV1 = context.scope,
  ): WorkerTaskResources | undefined {
    const ownerId = `${context.ownerId}:task:${String(taskId)}`;
    const result = context.coordinator.admitBatch({
      completionBytes: bytes,
      operations: taskRequests(context, ownerId, bytes, scope),
    });
    return result.kind === "admitted"
      ? new WorkerTaskResources(result.handle)
      : undefined;
  }

  public activateExecution(workerOwned: boolean, ownerId: string): boolean {
    if (!this.handle.activate()) return false;
    return !workerOwned || this.handle.transfer(`${ownerId}:detached`);
  }

  public activateCancellation(): boolean {
    return this.handle.state === "active";
  }

  public publish(
    output: Uint8Array<ArrayBuffer>,
    ownerId: string,
  ): PhaseZeroOwnedResult | undefined {
    if (this.#completionPublished) return undefined;
    if (!this.handle.publishCompletion(ownerId)) return undefined;
    this.#completionPublished = true;
    return attachRelease(output, (): boolean => this.handle.release());
  }

  public release(): boolean {
    return this.handle.release();
  }
}

function taskRequests(
  context: WorkerResourceContext,
  ownerId: string,
  bytes: number,
  scope: ResourceScopeV1,
): readonly ResourceAdmissionRequestV1[] {
  const specifications: readonly [ResourceCategoryV1, number, number][] = [
    [RESOURCE_CATEGORIES_V1.workerQueuedJob, 1, 0],
    [RESOURCE_CATEGORIES_V1.workerInput, 1, bytes],
    [RESOURCE_CATEGORIES_V1.workerOutput, 1, bytes],
    [RESOURCE_CATEGORIES_V1.workerScratch, 1, PHASE_ZERO_CHUNK_BYTES],
    [RESOURCE_CATEGORIES_V1.workerTransfer, 1, 0],
    [RESOURCE_CATEGORIES_V1.workerDetachedBuffer, 1, 0],
    [RESOURCE_CATEGORIES_V1.workerCancellation, 1, 0],
    [RESOURCE_CATEGORIES_V1.asyncContinuation, 1, 0],
    [RESOURCE_CATEGORIES_V1.timer, 1, 0],
  ];
  return specifications.map(([category, count, chargeBytes]) =>
    request(context, category, ownerId, count, chargeBytes, scope),
  );
}

function request(
  context: WorkerResourceContext,
  category: ResourceCategoryV1,
  ownerId: string,
  count: number,
  bytes: number,
  scope: ResourceScopeV1 = context.scope,
): ResourceAdmissionRequestV1 {
  return {
    bytes,
    category,
    count,
    ownerId,
    residency: "transient",
    scope,
  };
}

function attachRelease(
  output: Uint8Array<ArrayBuffer>,
  release: () => boolean,
): PhaseZeroOwnedResult {
  Object.defineProperty(output, "release", {
    configurable: false,
    enumerable: false,
    value: release,
    writable: false,
  });
  return output as PhaseZeroOwnedResult;
}
