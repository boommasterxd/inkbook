/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact protocol, queue, and byte boundaries are the tested behavior. */
import { describe, expect, it } from "vitest";

import { validateAndNormalizeSourceMapCompositionRequestV1 } from "../../src/application/source-coordination/map-composition-fallback";
import { encodedSourceOffsetMapBytes } from "../../src/application/source-coordination/offset-map";
import {
  MAX_WORKER_REQUEST_BYTES,
  WORKER_PROTOCOL_VERSION,
  type StructuredWorkRequest,
} from "../../src/workers/scheduler/protocol";
import {
  installSharedWorkerRuntime,
  type SharedWorkerScope,
} from "../../src/workers/shared-worker-runtime";

const REVISION = Object.freeze({ scene: 1, layout: 1 });

class AdversarialScope implements SharedWorkerScope {
  readonly responses: unknown[] = [];
  readonly timers: (() => void)[] = [];
  #listener: ((event: MessageEvent<unknown>) => void) | undefined;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.#listener = listener;
  }

  postMessage(message: unknown): void {
    this.responses.push(message);
  }

  setTimeout(callback: () => void): number {
    this.timers.push(callback);
    return this.timers.length;
  }

  dispatch(data: unknown): void {
    this.#listener?.(new MessageEvent("message", { data }));
  }

  flushTimers(): void {
    while (this.timers.length > 0) this.timers.shift()?.();
  }
}

function structured(
  requestId: number,
  workKind: StructuredWorkRequest["workKind"],
  payload: unknown,
  byteLength = 0,
  maxOutputBytes = 4_194_304,
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

function digest(
  requestId: number,
  kind: "digest-start" | "digest-finish" | "digest-cancel",
  digestId: number,
): StructuredWorkRequest {
  return structured(requestId, "source-digest", {
    wireVersion: 1,
    kind,
    digestId,
  });
}

function digestUpdate(
  requestId: number,
  digestId: number,
  chunk: unknown,
  byteLength: number,
): StructuredWorkRequest {
  return structured(
    requestId,
    "source-digest",
    { wireVersion: 1, kind: "digest-update", digestId, chunk },
    byteLength,
  );
}

function mapFixture(): {
  readonly byteLength: number;
  readonly payload: StructuredWorkRequest["payload"];
} {
  const result = validateAndNormalizeSourceMapCompositionRequestV1({
    wireVersion: 1,
    priorUtf16Length: 1,
    replacementUtf16Length: 2,
    scratchByteLimit: 8_388_608,
    segments: [
      {
        priorUtf16Length: 1,
        replacementUtf16Length: 2,
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
    ],
  });
  if (!result.ok) throw new Error("Expected valid map fixture.");
  const segment = result.value.segments[0];
  if (segment === undefined) throw new Error("Expected map segment.");
  return {
    byteLength: encodedSourceOffsetMapBytes(
      segment.offsetMap,
      segment.priorUtf16Length,
      segment.replacementUtf16Length,
    ),
    payload: result.value,
  };
}

function expectLastKind(scope: AdversarialScope, kind: string): void {
  expect(scope.responses.at(-1)).toMatchObject({ kind });
}

describe("shared worker request validation", () => {
  it("ignores malformed envelopes and impossible byte reservations", () => {
    const scope = new AdversarialScope();
    installSharedWorkerRuntime(scope);
    for (const value of [
      null,
      1,
      {},
      { protocolVersion: 1, kind: "cancel", requestId: 1 },
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "cancel",
        requestId: 0,
      },
      structured(1, "source-digest", {}, -1),
      { ...structured(2, "source-digest", {}), revision: null },
      {
        ...structured(3, "source-digest", {}),
        revision: { scene: -1, layout: 0 },
      },
      { ...structured(4, "source-digest", {}), maxOutputBytes: -1 },
      { ...structured(5, "source-digest", {}), scratchBytes: -1 },
      { ...structured(6, "source-digest", {}), kind: "unknown" },
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "process",
        requestId: 7,
        workKind: "byte-process",
        revision: REVISION,
        byteLength: 2,
        maxOutputBytes: 1,
        scratchBytes: 0,
        chunkBytes: 16_384,
        payload: new ArrayBuffer(1),
      },
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "process",
        requestId: 8,
        workKind: "byte-process",
        revision: REVISION,
        byteLength: MAX_WORKER_REQUEST_BYTES + 1,
        maxOutputBytes: 1,
        scratchBytes: 0,
        chunkBytes: 16_384,
        payload: new ArrayBuffer(MAX_WORKER_REQUEST_BYTES + 1),
      },
    ]) {
      scope.dispatch(value);
    }
    expect(scope.responses).toEqual([]);
  });
});

describe("shared worker digest failures", () => {
  it("rejects malformed phases, chunks, reservations, duplicates, and missing sessions", () => {
    const scope = new AdversarialScope();
    installSharedWorkerRuntime(scope);
    const invalidPayloads = [
      null,
      {},
      { wireVersion: 2, kind: "digest-start", digestId: 1 },
      { wireVersion: 1, kind: "digest-start", digestId: 0 },
      { wireVersion: 1, kind: "unknown", digestId: 1 },
    ];
    let requestId = 1;
    for (const payload of invalidPayloads) {
      scope.dispatch(structured(requestId, "source-digest", payload));
      expectLastKind(scope, "error");
      requestId += 1;
    }

    scope.dispatch(digestUpdate(requestId++, 1, "not-bytes", 0));
    expectLastKind(scope, "error");
    const backing = new Uint8Array([1, 2]);
    scope.dispatch(digestUpdate(requestId++, 1, backing.subarray(1), 1));
    expectLastKind(scope, "error");
    scope.dispatch(
      digestUpdate(requestId++, 1, new Uint8Array(262_145), 262_145),
    );
    expectLastKind(scope, "error");
    scope.dispatch(digestUpdate(requestId++, 99, new Uint8Array([1]), 1));
    expectLastKind(scope, "error");
    scope.dispatch(digest(requestId++, "digest-finish", 99));
    expectLastKind(scope, "error");

    scope.dispatch(digest(requestId++, "digest-start", 7));
    expectLastKind(scope, "structured-complete");
    scope.dispatch(digest(requestId++, "digest-start", 7));
    expectLastKind(scope, "error");
    scope.dispatch(digestUpdate(requestId++, 7, new Uint8Array([1]), 0));
    expectLastKind(scope, "error");
    scope.dispatch(digest(requestId++, "digest-cancel", 7));
    expectLastKind(scope, "structured-complete");
    scope.dispatch(digest(requestId, "digest-cancel", 404));
    expectLastKind(scope, "structured-complete");
  });

  it("enforces digest session and cumulative input bounds", () => {
    const scope = new AdversarialScope();
    installSharedWorkerRuntime(scope);
    for (let digestId = 1; digestId <= 64; digestId += 1) {
      scope.dispatch(digest(digestId, "digest-start", digestId));
      expectLastKind(scope, "structured-complete");
    }
    scope.dispatch(digest(65, "digest-start", 65));
    expectLastKind(scope, "error");

    const bounded = new AdversarialScope();
    installSharedWorkerRuntime(bounded);
    bounded.dispatch(digest(100, "digest-start", 1));
    const chunk = new Uint8Array(262_144);
    for (let index = 0; index < 64; index += 1) {
      bounded.dispatch(digestUpdate(101 + index, 1, chunk, chunk.byteLength));
    }
    bounded.dispatch(digestUpdate(200, 1, new Uint8Array([1]), 1));
    expectLastKind(bounded, "error");
  });
});

describe("shared worker map admission and cancellation", () => {
  it("reports invalid maps, reservation mismatches, duplicates, and cancelled stale turns", () => {
    const scope = new AdversarialScope();
    installSharedWorkerRuntime(scope);
    scope.dispatch(structured(1, "source-map-compose", { wireVersion: 1 }));
    expectLastKind(scope, "structured-complete");

    const fixture = mapFixture();
    scope.dispatch(
      structured(
        2,
        "source-map-compose",
        fixture.payload,
        fixture.byteLength + 1,
      ),
    );
    expectLastKind(scope, "error");
    scope.dispatch(
      structured(3, "source-map-compact", fixture.payload, fixture.byteLength),
    );
    scope.dispatch(
      structured(3, "source-map-compact", fixture.payload, fixture.byteLength),
    );
    expectLastKind(scope, "error");
    scope.dispatch({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      kind: "cancel",
      requestId: 3,
    });
    expectLastKind(scope, "cancelled");
    scope.flushTimers();
    expectLastKind(scope, "cancelled");
  });

  it("enforces the 64-job map queue and output reservation", () => {
    const fixture = mapFixture();
    const saturated = new AdversarialScope();
    installSharedWorkerRuntime(saturated);
    for (let requestId = 1; requestId <= 64; requestId += 1) {
      saturated.dispatch(
        structured(
          requestId,
          "source-map-compose",
          fixture.payload,
          fixture.byteLength,
        ),
      );
    }
    saturated.dispatch(
      structured(65, "source-map-compose", fixture.payload, fixture.byteLength),
    );
    expectLastKind(saturated, "error");

    const bounded = new AdversarialScope();
    installSharedWorkerRuntime(bounded);
    bounded.dispatch(
      structured(
        70,
        "source-map-compose",
        fixture.payload,
        fixture.byteLength,
        0,
      ),
    );
    expect(() => bounded.flushTimers()).toThrow(
      "Worker output exceeds its bound.",
    );
  });
});
