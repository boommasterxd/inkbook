import {
  createPersistenceCodecFallbackProcessorV1,
  normalizePersistenceCodecWorkV1,
  PersistenceElementChunkCacheV1,
  type PersistenceCodecWorkResultV1,
} from "../application/persistence";
import {
  PERSISTENCE_WORKER_CACHE_BYTES_V1,
  PERSISTENCE_WORKER_CACHE_COUNT_V1,
} from "./persistence-cache-budget";
import type { StructuredWorkRequest } from "./scheduler/protocol";

const MAX_PERSISTENCE_JOBS = 64;
const PERSISTENCE_UNITS_PER_TURN = 64;

export interface PersistenceWorkerTurnScopeV1 {
  setTimeout(callback: () => void, delay: number): number;
}

export interface PersistenceWorkerRuntimeV1 {
  start(request: StructuredWorkRequest): void;
  cancel(requestId: number): void;
  dispose(): void;
}

interface PersistenceJob {
  readonly request: StructuredWorkRequest;
  readonly processor: ReturnType<
    typeof createPersistenceCodecFallbackProcessorV1
  >;
}

export function createPersistenceWorkerRuntimeV1(
  scope: PersistenceWorkerTurnScopeV1,
  postResult: (
    request: StructuredWorkRequest,
    result: PersistenceCodecWorkResultV1,
  ) => void,
  postError: (requestId: number) => void,
): PersistenceWorkerRuntimeV1 {
  const jobs = new Map<number, PersistenceJob>();
  const elementCache = new PersistenceElementChunkCacheV1(
    PERSISTENCE_WORKER_CACHE_BYTES_V1,
    PERSISTENCE_WORKER_CACHE_COUNT_V1,
  );
  let disposed = false;

  const fail = (job: PersistenceJob): void => {
    if (jobs.delete(job.request.requestId)) job.processor.dispose();
    postError(job.request.requestId);
  };
  const runTurn = (job: PersistenceJob): void => {
    if (jobs.get(job.request.requestId) !== job) return;
    try {
      let complete = false;
      for (let unit = 0; unit < PERSISTENCE_UNITS_PER_TURN; unit += 1) {
        if (!job.processor.processNext()) continue;
        complete = true;
        break;
      }
      if (!complete) {
        scope.setTimeout(() => runTurn(job), 0);
        return;
      }
      const result = job.processor.complete();
      jobs.delete(job.request.requestId);
      try {
        postResult(job.request, result);
      } finally {
        job.processor.dispose();
      }
    } catch {
      fail(job);
    }
  };
  const start = (request: StructuredWorkRequest): void => {
    if (disposed) throw new Error("Persistence worker is disposed.");
    const work = normalizePersistenceCodecWorkV1(request.payload);
    assertPersistenceReservation(request, work);
    if (jobs.has(request.requestId) || jobs.size >= MAX_PERSISTENCE_JOBS) {
      throw new Error("Persistence worker admission failed.");
    }
    const job = {
      request,
      processor: createPersistenceCodecFallbackProcessorV1(work, elementCache),
    };
    jobs.set(request.requestId, job);
    try {
      scope.setTimeout(() => runTurn(job), 0);
    } catch (error: unknown) {
      jobs.delete(request.requestId);
      job.processor.dispose();
      throw error;
    }
  };
  const cancel = (requestId: number): void => {
    const job = jobs.get(requestId);
    if (job === undefined) return;
    jobs.delete(requestId);
    job.processor.dispose();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const job of jobs.values()) job.processor.dispose();
    jobs.clear();
    elementCache.dispose();
  };
  return Object.freeze({ start, cancel, dispose });
}

function assertPersistenceReservation(
  request: StructuredWorkRequest,
  work: ReturnType<typeof normalizePersistenceCodecWorkV1>,
): void {
  if (
    (request.workKind === "persistence-encode") !==
    (work.kind === "encode-sidecar")
  ) {
    throw new TypeError("Persistence work kind does not match its payload.");
  }
  const admittedInputBytes =
    work.kind === "encode-sidecar"
      ? work.admittedInputBytes
      : work.admittedUtf8Bytes;
  if (admittedInputBytes !== request.byteLength) {
    throw new RangeError("Persistence input reservation does not match.");
  }
}
