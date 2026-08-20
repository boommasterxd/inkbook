import type { PersistenceCodecPortV1 } from "../application/persistence";
import type {
  SourceDigestWorkPortV1,
  SourceMapWorkPortV1,
} from "../application/source-coordination/work-ports";
import { SchedulerPersistenceCodecPortV1 } from "./persistence-codec-port";
import {
  launchByteWorker,
  type BrowserWorkerEnvironment,
} from "./scheduler/browser-worker-adapter";
import type { WorkerRevision } from "./scheduler/protocol";
import { ByteWorkerScheduler } from "./scheduler/scheduler";
import type {
  ByteWorkerSchedulerOptions,
  WorkerSliceScheduler,
} from "./scheduler/scheduler-types";
import {
  assertPersistenceCacheBudgetV1,
  PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
  PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
  PERSISTENCE_WORKER_CACHE_BYTES_V1,
  PERSISTENCE_WORKER_CACHE_COUNT_V1,
} from "./persistence-cache-budget";
import { SchedulerSourceDigestWorkPortV1 } from "./source-digest-port";
import { SchedulerSourceMapWorkPortV1 } from "./source-map-port";
import { readStaticSharedWorkerSource } from "./static-worker-source";

const MAX_OUTSTANDING_REQUESTS = 64;
const MAX_OUTSTANDING_INPUT_BYTES = 16_777_216;
const MAX_RESERVED_BYTES = 167_772_160;

export interface SharedWorkerPortsOptionsV1 {
  readonly environment: BrowserWorkerEnvironment | null;
  readonly clock: ByteWorkerSchedulerOptions["clock"];
  readonly slices: WorkerSliceScheduler;
  readonly readRevision: () => WorkerRevision;
  readonly isCurrent: (revision: WorkerRevision) => boolean;
}

export interface SharedWorkerPortsV1 {
  readonly sourceMapCompaction: SourceMapWorkPortV1;
  readonly sourceDigest: SourceDigestWorkPortV1;
  readonly persistenceCodec: PersistenceCodecPortV1;
  dispose(): void;
}

export function createSharedWorkerPortsV1(
  options: SharedWorkerPortsOptionsV1,
): SharedWorkerPortsV1 {
  assertPersistenceCacheBudgetV1(
    PERSISTENCE_WORKER_CACHE_BYTES_V1,
    PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
    PERSISTENCE_WORKER_CACHE_COUNT_V1,
    PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
  );
  const source =
    options.environment === null ? null : readStaticSharedWorkerSource();
  const scheduler = new ByteWorkerScheduler({
    launchWorker: (): ReturnType<typeof launchByteWorker> =>
      options.environment === null || source === null
        ? undefined
        : launchByteWorker(options.environment, source),
    clock: options.clock,
    slices: options.slices,
    isCurrent: options.isCurrent,
    processFallbackByte: (value): number => value,
    maxOutstandingRequests: MAX_OUTSTANDING_REQUESTS,
    maxOutstandingBytes: MAX_OUTSTANDING_INPUT_BYTES,
    maxReservedBytes: MAX_RESERVED_BYTES,
  });
  const persistenceCodec = new SchedulerPersistenceCodecPortV1(
    scheduler,
    options.readRevision,
  );
  return Object.freeze({
    sourceMapCompaction: new SchedulerSourceMapWorkPortV1(
      scheduler,
      "source-map-compact",
      options.readRevision,
    ),
    sourceDigest: new SchedulerSourceDigestWorkPortV1(
      scheduler,
      options.readRevision,
    ),
    persistenceCodec,
    dispose: (): void => {
      scheduler.dispose();
      persistenceCodec.dispose();
    },
  });
}
