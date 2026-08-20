import { sha256 } from "@noble/hashes/sha2.js";

import type { PersistenceCodecWorkResultV1 } from "../application/persistence/codec-work";
import { commandSuccess } from "../application/note-session/results";
import {
  createSourceMapFallbackWorkV1,
  validateAndNormalizeSourceMapCompositionRequestV1,
} from "../application/source-coordination/map-composition-fallback";
import { encodedSourceOffsetMapBytes } from "../application/source-coordination/offset-map";
import type {
  CommandResultV1,
  Sha256Digest,
} from "../application/note-session/types";
import type { SourceOffsetMapV1 } from "../application/source-coordination/types";
import type { NormalizedSourceMapCompositionRequestV1 } from "../application/source-coordination/work-ports";
import {
  createPersistenceWorkerRuntimeV1,
  type PersistenceWorkerRuntimeV1,
} from "./persistence-worker-runtime";
import {
  MAX_WORKER_DECODED_OUTPUT_BYTES,
  MAX_WORKER_REQUEST_BYTES,
  MAX_WORKER_TASK_INPUT_BYTES,
  MAX_WORKER_TASK_SCRATCH_BYTES,
  WORKER_PROTOCOL_VERSION,
  type ByteWorkerRequest,
  type StructuredWorkRequest,
  type WorkerRevision,
} from "./scheduler/protocol";

const MAP_UNITS_PER_TURN = 1_024;
const MAX_MAP_JOBS = 64;
const MAX_DIGEST_SESSIONS = 64;
const MAX_DIGEST_CHUNK_BYTES = 262_144;
const SHA256_BYTES = 32;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export interface SharedWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  setTimeout(callback: () => void, delay: number): number;
}

export interface SharedWorkerRuntimeOwnerV1 {
  dispose(): void;
}

interface MapJob {
  readonly request: StructuredWorkRequest;
  readonly work: ReturnType<typeof createSourceMapFallbackWorkV1>;
}

interface DigestState {
  readonly hasher: ReturnType<typeof sha256.create>;
  byteLength: number;
}

interface WorkerRuntimeState {
  readonly mapJobs: Map<number, MapJob>;
  readonly digests: Map<number, DigestState>;
  readonly persistence: PersistenceWorkerRuntimeV1;
  disposed: boolean;
}

type DigestPayload =
  | {
      readonly wireVersion: 1;
      readonly kind: "digest-start";
      readonly digestId: number;
    }
  | {
      readonly wireVersion: 1;
      readonly kind: "digest-update";
      readonly digestId: number;
      readonly chunk: Uint8Array<ArrayBuffer>;
    }
  | {
      readonly wireVersion: 1;
      readonly kind: "digest-finish";
      readonly digestId: number;
    }
  | {
      readonly wireVersion: 1;
      readonly kind: "digest-cancel";
      readonly digestId: number;
    };

export function installSharedWorkerRuntime(
  scope: SharedWorkerScope,
): SharedWorkerRuntimeOwnerV1 {
  const state: WorkerRuntimeState = {
    mapJobs: new Map(),
    digests: new Map(),
    persistence: createPersistenceWorkerRuntimeV1(
      scope,
      (request, result): void => postPersistence(scope, request, result),
      (requestId): void => postWorkerError(scope, requestId),
    ),
    disposed: false,
  };

  scope.addEventListener("message", (event): void => {
    if (state.disposed) return;
    const request = readRequest(event.data);
    if (request === null) return;
    if (request.kind === "cancel") {
      const mapJob = state.mapJobs.get(request.requestId);
      mapJob?.work.cancel();
      state.mapJobs.delete(request.requestId);
      state.persistence.cancel(request.requestId);
      scope.postMessage({
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "cancelled",
        requestId: request.requestId,
      });
      return;
    }
    try {
      if (request.kind === "process") {
        scope.postMessage(
          {
            protocolVersion: WORKER_PROTOCOL_VERSION,
            kind: "complete",
            requestId: request.requestId,
            revision: request.revision,
            byteLength: request.payload.byteLength,
            payload: request.payload,
          },
          [request.payload],
        );
      } else processStructured(scope, state, request);
    } catch {
      postWorkerError(scope, request.requestId);
    }
  });
  return Object.freeze({ dispose: (): void => disposeRuntime(state) });
}

function disposeRuntime(state: WorkerRuntimeState): void {
  if (state.disposed) return;
  state.disposed = true;
  for (const job of state.mapJobs.values()) job.work.cancel();
  state.mapJobs.clear();
  for (const digest of state.digests.values()) digest.hasher.destroy();
  state.digests.clear();
  state.persistence.dispose();
}

function processStructured(
  scope: SharedWorkerScope,
  state: WorkerRuntimeState,
  request: StructuredWorkRequest,
): void {
  if (
    request.workKind === "source-map-compose" ||
    request.workKind === "source-map-compact"
  ) {
    startMap(scope, state, request);
    return;
  }
  if (request.workKind === "source-digest") {
    const result = processDigest(state.digests, request);
    postStructured(scope, request, result, SHA256_BYTES);
    return;
  }
  state.persistence.start(request);
}

function startMap(
  scope: SharedWorkerScope,
  state: WorkerRuntimeState,
  request: StructuredWorkRequest,
): void {
  const normalized = validateAndNormalizeSourceMapCompositionRequestV1(
    request.payload,
  );
  if (!normalized.ok) {
    postStructured(scope, request, normalized, 0);
    return;
  }
  if (mapInputBytes(normalized.value) !== request.byteLength) {
    throw new RangeError("Source map input reservation does not match.");
  }
  if (
    state.mapJobs.has(request.requestId) ||
    state.mapJobs.size >= MAX_MAP_JOBS
  ) {
    throw new Error("Source map worker admission failed.");
  }
  const job = {
    request,
    work: createSourceMapFallbackWorkV1(normalized.value),
  };
  state.mapJobs.set(request.requestId, job);
  scope.setTimeout(() => runMapTurn(scope, state, job), 0);
}

function runMapTurn(
  scope: SharedWorkerScope,
  state: WorkerRuntimeState,
  job: MapJob,
): void {
  if (state.mapJobs.get(job.request.requestId) !== job) return;
  let units = 0;
  const progress = job.work.resume({
    shouldYield: (): boolean => units++ >= MAP_UNITS_PER_TURN,
  });
  if (!progress.ok) {
    state.mapJobs.delete(job.request.requestId);
    postStructured(scope, job.request, progress, 0);
    return;
  }
  if (progress.value.kind === "completed") {
    state.mapJobs.delete(job.request.requestId);
    const result = commandSuccess(progress.value.offsetMap);
    postStructured(
      scope,
      job.request,
      result,
      mapResultBytes(result, job.request),
    );
    return;
  }
  scope.setTimeout(() => runMapTurn(scope, state, job), 0);
}

function postWorkerError(scope: SharedWorkerScope, requestId: number): void {
  scope.postMessage({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "error",
    requestId,
    message: "Worker request failed.",
  });
}

function processDigest(
  digests: Map<number, DigestState>,
  request: StructuredWorkRequest,
): unknown {
  const payload = readDigestPayload(request.payload);
  const inputBytes =
    payload.kind === "digest-update" ? payload.chunk.length : 0;
  if (inputBytes !== request.byteLength) {
    throw new RangeError("Digest input reservation does not match.");
  }
  if (payload.kind === "digest-cancel") {
    digests.get(payload.digestId)?.hasher.destroy();
    digests.delete(payload.digestId);
    return Object.freeze({ wireVersion: 1, kind: "digest-accepted" });
  }
  if (payload.kind === "digest-start") {
    if (digests.has(payload.digestId) || digests.size >= MAX_DIGEST_SESSIONS) {
      throw new Error("Digest session admission failed.");
    }
    digests.set(payload.digestId, { hasher: sha256.create(), byteLength: 0 });
    return Object.freeze({ wireVersion: 1, kind: "digest-accepted" });
  }
  const state = digests.get(payload.digestId);
  if (state === undefined) throw new Error("Digest session is unavailable.");
  if (payload.kind === "digest-update") {
    if (
      state.byteLength >
      MAX_WORKER_TASK_INPUT_BYTES - payload.chunk.byteLength
    ) {
      state.hasher.destroy();
      digests.delete(payload.digestId);
      throw new Error("Digest input exceeds its bound.");
    }
    state.hasher.update(payload.chunk);
    state.byteLength += payload.chunk.byteLength;
    return Object.freeze({ wireVersion: 1, kind: "digest-accepted" });
  }
  digests.delete(payload.digestId);
  return Object.freeze({
    wireVersion: 1,
    kind: "digest-complete",
    result: commandSuccess(bytesToHex(state.hasher.digest()) as Sha256Digest),
  });
}

function mapInputBytes(
  request: NormalizedSourceMapCompositionRequestV1,
): number {
  return request.segments.reduce(
    (total, segment) =>
      total +
      encodedSourceOffsetMapBytes(
        segment.offsetMap,
        segment.priorUtf16Length,
        segment.replacementUtf16Length,
      ),
    0,
  );
}

function postPersistence(
  scope: SharedWorkerScope,
  request: StructuredWorkRequest,
  result: PersistenceCodecWorkResultV1,
): void {
  const outputBytes =
    result.kind === "encoded-sidecar"
      ? result.bytes.byteLength
      : normalizeDecodedReservation(request.payload);
  postStructured(
    scope,
    request,
    result,
    outputBytes,
    result.kind === "encoded-sidecar" ? [result.bytes.buffer] : [],
  );
}

function postStructured(
  scope: SharedWorkerScope,
  request: StructuredWorkRequest,
  payload: unknown,
  byteLength: number,
  transfer: Transferable[] = [],
): void {
  if (byteLength > request.maxOutputBytes)
    throw new Error("Worker output exceeds its bound.");
  scope.postMessage(
    {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      kind: "structured-complete",
      requestId: request.requestId,
      revision: request.revision,
      byteLength,
      payload,
    },
    transfer,
  );
}

function mapResultBytes(
  result: CommandResultV1<SourceOffsetMapV1>,
  request: StructuredWorkRequest,
): number {
  if (!result.ok) return 0;
  const payload = request.payload as {
    priorUtf16Length?: unknown;
    replacementUtf16Length?: unknown;
  };
  if (
    typeof payload.priorUtf16Length !== "number" ||
    typeof payload.replacementUtf16Length !== "number"
  ) {
    throw new Error("Source map lengths are unavailable.");
  }
  return encodedSourceOffsetMapBytes(
    result.value,
    payload.priorUtf16Length,
    payload.replacementUtf16Length,
  );
}

function normalizeDecodedReservation(value: unknown): number {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Invalid persistence work.");
  const admitted = (value as { admittedDecodedBytes?: unknown })
    .admittedDecodedBytes;
  if (!Number.isSafeInteger(admitted) || (admitted as number) <= 0) {
    throw new RangeError("Invalid decoded byte reservation.");
  }
  return admitted as number;
}

function readRequest(value: unknown): ByteWorkerRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const request = value as Partial<ByteWorkerRequest>;
  if (
    request.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    !isPositiveSafeInteger(request.requestId)
  ) {
    return null;
  }
  if (request.kind === "cancel") return request as ByteWorkerRequest;
  const processRequest = request as Partial<
    Exclude<ByteWorkerRequest, { readonly kind: "cancel" }>
  >;
  if (
    !isRevision(processRequest.revision) ||
    !hasValidRequestBounds(processRequest)
  ) {
    return null;
  }
  if (request.kind === "process" && request.payload instanceof ArrayBuffer) {
    return request.payload.byteLength === request.byteLength &&
      request.byteLength <= MAX_WORKER_REQUEST_BYTES
      ? (request as ByteWorkerRequest)
      : null;
  }
  if (request.kind === "process-structured")
    return request as ByteWorkerRequest;
  return null;
}

function readDigestPayload(value: unknown): DigestPayload {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Invalid digest work.");
  const payload = value as Partial<DigestPayload>;
  if (payload.wireVersion !== 1 || !isPositiveSafeInteger(payload.digestId)) {
    throw new TypeError("Invalid digest work.");
  }
  if (payload.kind === "digest-update") {
    if (
      !(payload.chunk instanceof Uint8Array) ||
      !(payload.chunk.buffer instanceof ArrayBuffer) ||
      payload.chunk.byteOffset !== 0 ||
      payload.chunk.byteLength !== payload.chunk.buffer.byteLength ||
      payload.chunk.byteLength > MAX_DIGEST_CHUNK_BYTES
    ) {
      throw new TypeError("Invalid digest chunk.");
    }
    return payload as DigestPayload;
  }
  if (
    payload.kind !== "digest-start" &&
    payload.kind !== "digest-finish" &&
    payload.kind !== "digest-cancel"
  ) {
    throw new TypeError("Invalid digest work.");
  }
  return payload as DigestPayload;
}

function isRevision(value: unknown): value is WorkerRevision {
  if (typeof value !== "object" || value === null) return false;
  const revision = value as Partial<WorkerRevision>;
  return (
    isNonNegativeSafeInteger(revision.scene) &&
    isNonNegativeSafeInteger(revision.layout)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasValidRequestBounds(
  request: Partial<Exclude<ByteWorkerRequest, { readonly kind: "cancel" }>>,
): boolean {
  return (
    typeof request.byteLength === "number" &&
    Number.isSafeInteger(request.byteLength) &&
    request.byteLength >= 0 &&
    request.byteLength <= MAX_WORKER_TASK_INPUT_BYTES &&
    typeof request.maxOutputBytes === "number" &&
    Number.isSafeInteger(request.maxOutputBytes) &&
    request.maxOutputBytes >= 0 &&
    request.maxOutputBytes <= MAX_WORKER_DECODED_OUTPUT_BYTES &&
    typeof request.scratchBytes === "number" &&
    Number.isSafeInteger(request.scratchBytes) &&
    request.scratchBytes >= 0 &&
    request.scratchBytes <= MAX_WORKER_TASK_SCRATCH_BYTES
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
}
