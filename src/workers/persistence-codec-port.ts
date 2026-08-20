import {
  createPersistenceCodecFallbackProcessorV1,
  normalizePersistenceCodecWorkResultV1,
  normalizePersistenceCodecWorkV1,
  PersistenceElementChunkCacheV1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
  type PersistenceCodecPortV1,
  type PersistenceCodecSubmissionV1,
  type PersistenceCodecWorkV1,
} from "../application/persistence";
import type { WorkerRevision } from "./scheduler/protocol";
import { ByteWorkerScheduler } from "./scheduler/scheduler";
import {
  PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
  PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
} from "./persistence-cache-budget";

const PERSISTENCE_SCRATCH_BYTES = 8_388_608;

export class SchedulerPersistenceCodecPortV1 implements PersistenceCodecPortV1 {
  readonly #fallbackCache = new PersistenceElementChunkCacheV1(
    PERSISTENCE_FALLBACK_CACHE_BYTES_V1,
    PERSISTENCE_FALLBACK_CACHE_COUNT_V1,
  );

  constructor(
    private readonly scheduler: ByteWorkerScheduler,
    private readonly readRevision: () => WorkerRevision,
  ) {}

  submit(work: PersistenceCodecWorkV1): PersistenceCodecSubmissionV1 {
    const normalized = normalizePersistenceCodecWorkV1(work);
    const submission = this.scheduler.submitStructured({
      kind:
        normalized.kind === "encode-sidecar"
          ? "persistence-encode"
          : "persistence-parse",
      payload: normalized,
      inputBytes: persistenceInputBytes(normalized),
      revision: this.readRevision(),
      priority: "background",
      mode: "idle",
      maxOutputBytes: persistenceOutputBytes(normalized),
      scratchBytes: PERSISTENCE_SCRATCH_BYTES,
      createFallbackProcessor: () =>
        createPersistenceCodecFallbackProcessorV1(
          normalized,
          this.#fallbackCache,
        ),
      normalizeResult: normalizePersistenceCodecWorkResultV1,
    });
    return Object.freeze({
      result: submission.result,
      cancel: (): void => submission.cancel(),
    });
  }

  dispose(): void {
    this.#fallbackCache.dispose();
  }
}

function persistenceInputBytes(work: PersistenceCodecWorkV1): number {
  return work.kind === "encode-sidecar"
    ? work.admittedInputBytes
    : work.admittedUtf8Bytes;
}

function persistenceOutputBytes(work: PersistenceCodecWorkV1): number {
  return work.kind === "encode-sidecar"
    ? SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1[work.writableTier]
    : work.admittedDecodedBytes;
}
