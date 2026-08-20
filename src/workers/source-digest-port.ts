import { sha256 } from "@noble/hashes/sha2.js";

import { commandSuccess } from "../application/note-session/results";
import {
  parseSha256Digest,
  type CommandResultV1,
  type Sha256Digest,
} from "../application/note-session";
import type {
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
} from "../application/source-coordination/work-ports";
import {
  WorkerRequestCancelledError,
  type WorkerRevision,
} from "./scheduler/protocol";
import type {
  StructuredWorkerSubmission,
  WorkerFallbackProcessor,
} from "./scheduler/scheduler-types";
import { ByteWorkerScheduler } from "./scheduler/scheduler";

const DIGEST_CHUNK_BYTES = 262_144;
const FALLBACK_HASH_CHUNK_BYTES = 16_384;
const SHA256_BYTES = 32;
const SHA256_SCRATCH_BYTES = 262_144;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

type DigestPhase =
  "digest-start" | "digest-update" | "digest-finish" | "digest-cancel";

interface DigestPayload {
  readonly wireVersion: 1;
  readonly kind: DigestPhase;
  readonly digestId: number;
  readonly chunk?: Uint8Array<ArrayBuffer>;
}

interface DigestAccepted {
  readonly wireVersion: 1;
  readonly kind: "digest-accepted";
}

interface DigestCompleted {
  readonly wireVersion: 1;
  readonly kind: "digest-complete";
  readonly result: CommandResultV1<Sha256Digest>;
}

type DigestResponse = DigestAccepted | DigestCompleted;

class DigestFallbackState {
  hasher: ReturnType<typeof sha256.create> | undefined;
}

export class SchedulerSourceDigestWorkPortV1 implements SourceDigestWorkPortV1 {
  #nextDigestId = 1;

  constructor(
    private readonly scheduler: ByteWorkerScheduler,
    private readonly readRevision: () => WorkerRevision,
  ) {}

  submit(): SourceDigestWorkSubmissionV1 {
    const digestId = this.#nextDigestId++;
    if (!Number.isSafeInteger(digestId)) {
      throw new RangeError("Digest work identifiers are exhausted.");
    }
    const state = new DigestFallbackState();
    let current:
      ReturnType<ByteWorkerScheduler["submitStructured"]> | undefined;
    let closed = false;
    let cancelled = false;
    let resolveCompletion: (value: CommandResultV1<Sha256Digest>) => void;
    let rejectCompletion: (reason: Error) => void;
    const completion = new Promise<CommandResultV1<Sha256Digest>>(
      (resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      },
    );
    const run = (payload: DigestPayload): Promise<DigestResponse> => {
      if (cancelled) return Promise.reject(new WorkerRequestCancelledError());
      current = this.submitPhase(payload, state);
      return current.result as Promise<DigestResponse>;
    };
    let pending = run({ wireVersion: 1, kind: "digest-start", digestId });
    const update = (chunk: Uint8Array): Promise<void> => {
      if (closed || cancelled) throw new Error("The digest input is closed.");
      const owned = copyDigestChunk(chunk);
      pending = pending.then(() =>
        run({ wireVersion: 1, kind: "digest-update", digestId, chunk: owned }),
      );
      return pending.then(() => undefined);
    };
    const closeInput = (): void => {
      if (closed || cancelled) throw new Error("The digest input is closed.");
      closed = true;
      pending
        .then(() => run({ wireVersion: 1, kind: "digest-finish", digestId }))
        .then((response) => resolveCompletion(readDigestResult(response)))
        .catch((error: unknown) => rejectCompletion(asError(error)));
    };
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      current?.cancel();
      rejectCompletion(new WorkerRequestCancelledError());
      void pending.catch(() => undefined);
      try {
        const cleanup = this.submitPhase(
          { wireVersion: 1, kind: "digest-cancel", digestId },
          state,
        );
        void cleanup.result.catch(() => undefined);
      } catch {
        state.hasher?.destroy();
        state.hasher = undefined;
      }
    };
    return Object.freeze({ completion, update, closeInput, cancel });
  }

  private submitPhase(
    payload: DigestPayload,
    state: DigestFallbackState,
  ): StructuredWorkerSubmission<DigestResponse> {
    return this.scheduler.submitStructured({
      kind: "source-digest",
      payload,
      inputBytes: payload.chunk?.byteLength ?? 0,
      revision: this.readRevision(),
      priority: "current",
      mode: "active",
      maxOutputBytes: SHA256_BYTES,
      scratchBytes: SHA256_SCRATCH_BYTES,
      workerFirst: true,
      createFallbackProcessor: () => createDigestProcessor(payload, state),
      normalizeResult: normalizeDigestResponse,
    });
  }
}

function createDigestProcessor(
  payload: DigestPayload,
  state: DigestFallbackState,
): WorkerFallbackProcessor<DigestResponse> {
  let offset = 0;
  let result: DigestResponse | undefined;
  return {
    processNext(): boolean {
      if (payload.kind === "digest-start") {
        if (state.hasher !== undefined)
          throw new Error("Digest already started.");
        state.hasher = sha256.create();
        result = digestAccepted();
        return true;
      }
      if (payload.kind === "digest-cancel") {
        state.hasher?.destroy();
        state.hasher = undefined;
        result = digestAccepted();
        return true;
      }
      const hasher = state.hasher;
      if (hasher === undefined) throw new Error("Digest is unavailable.");
      if (payload.kind === "digest-finish") {
        state.hasher = undefined;
        result = Object.freeze({
          wireVersion: 1,
          kind: "digest-complete",
          result: commandSuccess(
            parseSha256Digest(bytesToHex(hasher.digest())),
          ),
        });
        return true;
      }
      const chunk = payload.chunk;
      if (chunk === undefined) throw new Error("Digest chunk is unavailable.");
      const end = Math.min(
        offset + FALLBACK_HASH_CHUNK_BYTES,
        chunk.byteLength,
      );
      hasher.update(chunk.subarray(offset, end));
      offset = end;
      if (offset < chunk.byteLength) return false;
      result = digestAccepted();
      return true;
    },
    complete(): DigestResponse {
      if (result === undefined) throw new Error("Digest work is incomplete.");
      return result;
    },
    dispose(): void {
      result = undefined;
    },
  };
}

function copyDigestChunk(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  if (chunk.byteLength > DIGEST_CHUNK_BYTES) {
    throw new RangeError("Digest chunks are limited to 256 KiB.");
  }
  const owned = new Uint8Array(chunk.byteLength);
  owned.set(chunk);
  return owned;
}

function normalizeDigestResponse(value: unknown): DigestResponse {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Digest result must be a record.");
  }
  const response = value as Partial<DigestResponse>;
  if (response.wireVersion !== 1)
    throw new TypeError("Digest wire version is invalid.");
  if (response.kind === "digest-accepted") return digestAccepted();
  if (response.kind !== "digest-complete")
    throw new TypeError("Digest result kind is invalid.");
  const result = response.result;
  if (result?.ok !== true || typeof result.value !== "string") {
    throw new TypeError("Digest completion is invalid.");
  }
  return Object.freeze({
    wireVersion: 1,
    kind: "digest-complete",
    result: commandSuccess(parseSha256Digest(result.value)),
  });
}

function readDigestResult(
  response: DigestResponse,
): CommandResultV1<Sha256Digest> {
  if (response.kind !== "digest-complete") {
    throw new TypeError("Digest input closed without a digest.");
  }
  return response.result;
}

function digestAccepted(): DigestAccepted {
  return Object.freeze({ wireVersion: 1, kind: "digest-accepted" });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Digest work failed.");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
}
