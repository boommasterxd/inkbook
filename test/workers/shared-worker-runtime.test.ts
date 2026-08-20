/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact protocol and boundary values are the tested contract. */
import { expect, it } from "vitest";

import {
  createPersistenceEncodeWorkV1,
  createPersistenceParseWorkV1,
  encodeInkbookSidecarV1,
} from "../../src/application/persistence";
import { validateAndNormalizeSourceMapCompositionRequestV1 } from "../../src/application/source-coordination/map-composition-fallback";
import { encodedSourceOffsetMapBytes } from "../../src/application/source-coordination/offset-map";
import {
  WORKER_PROTOCOL_VERSION,
  type ByteWorkerRequest,
  type ByteWorkerResponse,
  type StructuredWorkRequest,
  type WorkerRevision,
} from "../../src/workers/scheduler/protocol";
import {
  installSharedWorkerRuntime,
  type SharedWorkerScope,
} from "../../src/workers/shared-worker-runtime";
import { completeSidecar } from "../application/persistence/support";

const REVISION: WorkerRevision = { scene: 1, layout: 2 };

class ControlledWorkerScope implements SharedWorkerScope {
  readonly responses: ByteWorkerResponse[] = [];
  readonly transfers: Transferable[][] = [];
  readonly #timers: (() => void)[] = [];
  #listener: ((event: MessageEvent<unknown>) => void) | undefined;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.#listener = listener;
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.responses.push(
      structuredClone(message, { transfer }) as ByteWorkerResponse,
    );
    this.transfers.push(transfer);
  }

  setTimeout(callback: () => void): number {
    this.#timers.push(callback);
    return this.#timers.length;
  }

  dispatch(request: ByteWorkerRequest): void {
    this.#listener?.(new MessageEvent("message", { data: request }));
  }

  flushTimers(): void {
    while (this.#timers.length > 0) this.#timers.shift()?.();
  }
}

function structuredRequest(
  requestId: number,
  workKind: StructuredWorkRequest["workKind"],
  payload: unknown,
  byteLength: number,
  maxOutputBytes: number,
): StructuredWorkRequest {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "process-structured",
    requestId,
    workKind,
    revision: REVISION,
    byteLength,
    maxOutputBytes,
    scratchBytes: 8_388_608,
    payload,
  };
}

function persistenceEncodeFixture(): {
  readonly bytes: Uint8Array;
  readonly work: ReturnType<typeof createPersistenceEncodeWorkV1>;
} {
  const sidecar = completeSidecar();
  const bytes = encodeInkbookSidecarV1(sidecar, "phone");
  return {
    bytes,
    work: createPersistenceEncodeWorkV1(
      sidecar,
      "phone",
      1_048_576,
      bytes.byteLength,
    ),
  };
}

it("preserves the existing byte-work protocol with one ownership transfer", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const payload = new Uint8Array([1, 2, 3]).buffer;
  scope.dispatch({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "process",
    requestId: 9,
    workKind: "byte-process",
    revision: REVISION,
    byteLength: payload.byteLength,
    maxOutputBytes: payload.byteLength,
    scratchBytes: 0,
    chunkBytes: 16_384,
    payload,
  });

  const response = scope.responses[0];
  expect(response?.kind).toBe("complete");
  if (response?.kind !== "complete") return;
  expect(new Uint8Array(response.payload)).toEqual(new Uint8Array([1, 2, 3]));
  expect(scope.transfers[0]).toHaveLength(1);
});

it("computes a semantic streaming SHA-256 digest", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const chunk = new TextEncoder().encode("abc");

  scope.dispatch(
    structuredRequest(
      1,
      "source-digest",
      {
        wireVersion: 1,
        kind: "digest-start",
        digestId: 7,
      },
      0,
      32,
    ),
  );
  scope.dispatch(
    structuredRequest(
      2,
      "source-digest",
      {
        wireVersion: 1,
        kind: "digest-update",
        digestId: 7,
        chunk,
      },
      chunk.byteLength,
      32,
    ),
  );
  scope.dispatch(
    structuredRequest(
      3,
      "source-digest",
      {
        wireVersion: 1,
        kind: "digest-finish",
        digestId: 7,
      },
      0,
      32,
    ),
  );

  const completion = scope.responses[2];
  expect(completion?.kind).toBe("structured-complete");
  if (completion?.kind !== "structured-complete") return;
  expect(completion.payload).toEqual({
    wireVersion: 1,
    kind: "digest-complete",
    result: {
      ok: true,
      value: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
  });
});

it("composes canonical source maps and acknowledges cancellation", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const request = validateAndNormalizeSourceMapCompositionRequestV1({
    wireVersion: 1,
    priorUtf16Length: 3,
    replacementUtf16Length: 4,
    scratchByteLimit: 8_388_608,
    segments: [
      {
        priorUtf16Length: 3,
        replacementUtf16Length: 4,
        offsetMap: {
          spans: [
            {
              oldFromUtf16: 1,
              oldToUtf16: 1,
              newFromUtf16: 1,
              newToUtf16: 2,
            },
          ],
        },
      },
      {
        priorUtf16Length: 4,
        replacementUtf16Length: 4,
        offsetMap: { spans: [] },
      },
    ],
  });
  if (!request.ok) throw new Error("Source map fixture is invalid.");
  const inputBytes = request.value.segments.reduce(
    (total, segment) =>
      total +
      encodedSourceOffsetMapBytes(
        segment.offsetMap,
        segment.priorUtf16Length,
        segment.replacementUtf16Length,
      ),
    0,
  );

  scope.dispatch(
    structuredRequest(
      4,
      "source-map-compose",
      request.value,
      inputBytes,
      4_194_304,
    ),
  );
  scope.flushTimers();
  const response = scope.responses.at(-1);
  expect(response?.kind).toBe("structured-complete");
  if (response?.kind !== "structured-complete") return;
  expect(response.payload).toEqual({
    ok: true,
    value: request.value.segments[0]?.offsetMap,
  });

  scope.dispatch(
    structuredRequest(
      5,
      "source-map-compact",
      request.value,
      inputBytes,
      4_194_304,
    ),
  );
  scope.dispatch({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "cancel",
    requestId: 5,
  });
  expect(scope.responses.at(-1)?.kind).toBe("cancelled");
});

it("encodes and parses canonical sidecars with transferred output ownership", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const sidecar = completeSidecar();
  const expected = encodeInkbookSidecarV1(sidecar, "phone");
  const encodeWork = createPersistenceEncodeWorkV1(
    sidecar,
    "phone",
    1_048_576,
    expected.byteLength,
  );

  scope.dispatch(
    structuredRequest(
      6,
      "persistence-encode",
      encodeWork,
      expected.byteLength,
      8_388_608,
    ),
  );
  scope.flushTimers();
  const encoded = scope.responses.at(-1);
  expect(encoded?.kind).toBe("structured-complete");
  if (encoded?.kind !== "structured-complete") return;
  const encodedPayload = encoded.payload as { bytes: Uint8Array };
  expect(encodedPayload.bytes).toEqual(expected);
  expect(scope.transfers.at(-1)).toHaveLength(1);

  const rawText = new TextDecoder().decode(encodedPayload.bytes);
  const parseWork = createPersistenceParseWorkV1(
    rawText,
    encodedPayload.bytes.byteLength,
    1_048_576,
  );
  scope.dispatch(
    structuredRequest(
      7,
      "persistence-parse",
      parseWork,
      encodedPayload.bytes.byteLength,
      1_048_576,
    ),
  );
  scope.flushTimers();
  const parsed = scope.responses.at(-1);
  expect(parsed?.kind).toBe("structured-complete");
  if (parsed?.kind !== "structured-complete") return;
  expect(parsed.payload).toMatchObject({
    wireVersion: 1,
    kind: "parsed-sidecar",
    value: { kind: "current", sidecar },
  });
});

it("fails closed for malformed structured work", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  scope.dispatch(
    structuredRequest(8, "persistence-parse", { kind: "parse-sidecar" }, 0, 1),
  );
  expect(scope.responses).toEqual([
    {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      kind: "error",
      requestId: 8,
      message: "Worker request failed.",
    },
  ]);
});

it("rejects a persistence work kind that does not match its payload", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const sidecar = completeSidecar();
  const bytes = encodeInkbookSidecarV1(sidecar, "phone");
  const parseWork = createPersistenceParseWorkV1(
    new TextDecoder().decode(bytes),
    bytes.byteLength,
    1_048_576,
  );
  scope.dispatch(
    structuredRequest(
      10,
      "persistence-encode",
      parseWork,
      bytes.byteLength,
      8_388_608,
    ),
  );

  expect(scope.responses.at(-1)).toMatchObject({
    kind: "error",
    requestId: 10,
  });
});

it("rejects a packed payload whose declared input reservation is smaller", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const bytes = encodeInkbookSidecarV1(completeSidecar(), "phone");
  const parseWork = createPersistenceParseWorkV1(
    new TextDecoder().decode(bytes),
    bytes.byteLength,
    1_048_576,
  );

  scope.dispatch(
    structuredRequest(
      11,
      "persistence-parse",
      parseWork,
      bytes.byteLength - 1,
      1_048_576,
    ),
  );

  expect(scope.responses.at(-1)).toMatchObject({
    kind: "error",
    requestId: 11,
  });
});

it("cancels resumable persistence work before it can publish", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const { bytes, work } = persistenceEncodeFixture();
  scope.dispatch(
    structuredRequest(
      12,
      "persistence-encode",
      work,
      bytes.byteLength,
      8_388_608,
    ),
  );
  scope.dispatch({
    protocolVersion: WORKER_PROTOCOL_VERSION,
    kind: "cancel",
    requestId: 12,
  });
  scope.flushTimers();

  expect(scope.responses).toEqual([
    {
      protocolVersion: WORKER_PROTOCOL_VERSION,
      kind: "cancelled",
      requestId: 12,
    },
  ]);
});

it("disposes active worker jobs and ignores later messages idempotently", () => {
  const scope = new ControlledWorkerScope();
  const owner = installSharedWorkerRuntime(scope);
  const { bytes, work } = persistenceEncodeFixture();
  scope.dispatch(
    structuredRequest(
      14,
      "persistence-encode",
      work,
      bytes.byteLength,
      8_388_608,
    ),
  );

  owner.dispose();
  owner.dispose();
  scope.flushTimers();
  scope.dispatch(
    structuredRequest(
      15,
      "source-digest",
      { wireVersion: 1, kind: "digest-start", digestId: 15 },
      0,
      32,
    ),
  );
  expect(scope.responses).toEqual([]);
});

it("fails closed when resumable persistence output exceeds its reservation", () => {
  const scope = new ControlledWorkerScope();
  installSharedWorkerRuntime(scope);
  const { bytes, work } = persistenceEncodeFixture();
  scope.dispatch(
    structuredRequest(13, "persistence-encode", work, bytes.byteLength, 1),
  );
  scope.flushTimers();

  expect(scope.responses.at(-1)).toMatchObject({
    kind: "error",
    requestId: 13,
  });
});
