import { describe, expect, it, vi } from "vitest";
import * as sampleCopy from "../../../src/domain/elements/runtime-sample-copy";
import * as strokeSamples from "../../../src/domain/elements/public";
import * as requestWire from "../../../src/persistence/worker/runtime/request-wire-decoding";
import { attachDocumentWorkerHost } from "../../../src/persistence/worker/runtime/worker-host";
import { createProductionDocumentRuntime } from "../../../src/persistence/worker/runtime/production-document-runtime";
import { createWorkerBridgeEndpoints } from "../../fixtures/persistence/worker-bridge";
import { TestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import { ModelPointReferences } from "../../../src/persistence/worker/runtime/model-point-references";
import { copySnapshotToRuntimeSliced } from "../../../src/persistence/worker/runtime/runtime-elements";
import {
  encodeRuntimeRequestChunked,
  decodeRuntimeRequest,
  decodeRuntimeRequestChunked,
  encodeRuntimeRequest,
} from "../../../src/persistence/worker/runtime/wire-codec";
import {
  STROKE,
  snapshot,
  executor,
  unlockIdentity,
} from "../../unit/persistence/worker/runtime/fixtures";
import type {
  FullModelSyncRuntimeRequest,
  IncrementalModelSyncRuntimeRequest,
} from "../../../src/persistence/worker/runtime/types";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";

it("bounds snapshot sample reads per checkpoint and reuses completed frozen copies", async () => {
  const { observed: points, work } = observeSchemaArray(
    Array.from({ length: 12_000 }, (_, index) => (index % 3 === 2 ? 0.5 : Math.floor(index / 3))),
  );
  Object.freeze(points);
  work.indexedReads = 0;
  const input = { ...snapshot(), elements: [{ ...STROKE, points }] };
  const copies = new WeakMap();
  const readsPerSlice: number[] = [];
  let lastReads = 0;
  const context = {
    checkpoint: async () => {
      readsPerSlice.push(work.indexedReads - lastReads);
      lastReads = work.indexedReads;
    },
    signal: new AbortController().signal,
    workProfile: { inputByteLimit: 4_096, nodeLimit: 64, outputByteLimit: 16_384 },
  };
  const first = await copySnapshotToRuntimeSliced(input, context, copies);
  expect(work.indexedReads).toBe(12_000);
  expect(readsPerSlice).toHaveLength(72);
  expect(readsPerSlice.every((reads) => reads >= 0 && reads <= 510)).toBe(true);
  expect(readsPerSlice.reduce((total, reads) => total + reads, 0)).toBe(12_000);
  const second = await copySnapshotToRuntimeSliced(input, context, copies);
  expect(work.indexedReads).toBe(12_000);
  const firstStroke = first.elements[0];
  const secondStroke = second.elements[0];
  if (firstStroke?.kind !== "stroke" || secondStroke?.kind !== "stroke") {
    throw new Error("Expected copied strokes.");
  }
  expect(secondStroke.points).toBe(firstStroke.points);
});

it("admits hosted native wire decoding through the existing bounded runtime queue", async () => {
  const { clientEndpoint, hostEndpoint } = createWorkerBridgeEndpoints();
  clientEndpoint.cloneTransfers = true;
  hostEndpoint.cloneTransfers = true;
  const runtime = createProductionDocumentRuntime(executor, {
    workScheduler: new TestWorkScheduler(),
  });
  const detach = attachDocumentWorkerHost(hostEndpoint, runtime);
  const decode = vi.spyOn(requestWire, "decodeRuntimeRequestChunked");
  const scans = vi.spyOn(strokeSamples, "assertStrokeSamplesV1");
  const responses: unknown[] = [];
  let resolveResponses!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveResponses = resolve;
  });
  clientEndpoint.addEventListener("message", (event) => {
    responses.push(event.data);
    if (responses.length === 7) resolveResponses();
  });
  const first = encodeRuntimeRequest({
    baseModelRevision: null,
    identity: unlockIdentity,
    modelRevision: 0,
    snapshot: { ...snapshot(), elements: [STROKE] },
    type: "model-sync-full",
  });
  const queuedExport = encodeRuntimeRequest({
    ...executor,
    baseModelRevision: 0,
    exportGeneration: 1,
    modelRevision: 0,
    type: "export-incremental",
  });
  scans.mockClear();
  try {
    runtime.setLiveInputActive(true);
    clientEndpoint.postMessage(
      { requestId: 1, request: first.value, type: "inkbook-worker-request" },
      [...first.transfer],
    );
    for (let index = 0; index < 4; index += 1)
      clientEndpoint.postMessage({
        requestId: index + 2,
        type: "inkbook-worker-request",
        request: {
          identity: { ...unlockIdentity, operationId: index + 2, purpose: "verification" },
          input: "invalid",
          type: "verify-output",
        },
      });
    clientEndpoint.postMessage({
      requestId: 6,
      request: queuedExport.value,
      type: "inkbook-worker-request",
    });
    clientEndpoint.postMessage({
      requestId: 7,
      type: "inkbook-worker-request",
      request: {
        ...first.value,
        snapshot: {
          ...snapshot(),
          elements: {
            pointBuffers: [new Float64Array([Number.NaN, 0, 1])],
            records: [{ ...STROKE, points: undefined, pointsBufferIndex: 0 }],
          },
        },
      },
    });
    expect(runtime.instrumentation).toMatchObject({ retainedJobs: 6, queuedJobs: 5 });
    expect(decode).not.toHaveBeenCalled();
    expect(scans).not.toHaveBeenCalled();
    runtime.setLiveInputActive(false);
    await completed;
    expect(responses).toContainEqual(
      expect.objectContaining({
        requestId: 7,
        result: expect.objectContaining({ code: "queue-busy", type: "runtime-failure" }) as unknown,
      }),
    );
    expect(decode).toHaveBeenCalledTimes(6);
    expect(scans).toHaveBeenCalledOnce();
    expect(runtime.instrumentation).toMatchObject({ retainedJobs: 0, queuedJobs: 0 });
  } finally {
    detach();
    decode.mockRestore();
    scans.mockRestore();
  }
});

it("bounds long-stroke wire sample copying and decoding and cancels without publishing", async () => {
  const { observed: points, work } = observeSchemaArray(
    Array.from({ length: 49_152 }, (_, index) => (index % 3 === 2 ? 0.5 : index % 1000)),
  );
  const copy = vi.spyOn(sampleCopy, "copySampleRange");
  const scans = vi.spyOn(strokeSamples, "assertStrokeSamplesV1");
  try {
    let lastReads = 0;
    const encoded = await encodeRuntimeRequestChunked(
      {
        baseModelRevision: null,
        identity: unlockIdentity,
        modelRevision: 0,
        snapshot: { ...snapshot(), elements: [{ ...STROKE, points }] },
        type: "model-sync-full",
      },
      {
        checkpoint: () => {
          expect(work.indexedReads - lastReads).toBeLessThanOrEqual(768);
          lastReads = work.indexedReads;
          return undefined;
        },
        signal: new AbortController().signal,
      },
    );
    expect(work.indexedReads).toBe(49_152);
    expect(copy.mock.calls.reduce((count, call) => count + call[3] - call[2], 0)).toBe(49_152);
    expect(copy.mock.calls.every((call) => call[3] - call[2] <= 768)).toBe(true);
    expect(scans.mock.calls.every(([samples]) => samples.length <= 768)).toBe(true);
    scans.mockClear();
    let checkpoints = 0;
    const controller = new AbortController();
    await expect(
      decodeRuntimeRequestChunked(encoded.value, {
        checkpoint: () => {
          if (++checkpoints === 2) controller.abort();
          return undefined;
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(scans).toHaveBeenCalledOnce();
    expect(scans.mock.calls[0]![0].length).toBe(768);
    scans.mockClear();
    const decoded = await decodeRuntimeRequestChunked(encoded.value, {
      checkpoint: () => undefined,
      signal: new AbortController().signal,
    });
    expect(decoded.type).toBe("model-sync-full");
    expect(scans.mock.calls.reduce((count, [samples]) => count + samples.length, 0)).toBe(49_152);
    expect(scans.mock.calls.every(([samples]) => samples.length <= 768)).toBe(true);
    expect(copy.mock.calls.reduce((count, call) => count + call[3] - call[2], 0)).toBe(49_152);
  } finally {
    copy.mockRestore();
    scans.mockRestore();
  }
});

describe("worker translation sample work", () => {
  it("transfers no sample buffers and reads no samples when moving ten thousand strokes", async () => {
    const { observed: points, work } = observeSchemaArray([...STROKE.points]);
    Object.freeze(points);
    work.indexedReads = 0;
    const elements = Array.from({ length: 10_000 }, (_, index) => ({
      ...STROKE,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      points,
    }));
    const full: FullModelSyncRuntimeRequest = {
      baseModelRevision: null,
      identity: unlockIdentity,
      modelRevision: 0,
      snapshot: { ...snapshot(), elements },
      type: "model-sync-full",
    };
    const cache = new ModelPointReferences();
    const options = { checkpoint: () => Promise.resolve(), signal: new AbortController().signal };
    const initial = await encodeRuntimeRequestChunked(full, {
      ...options,
      reusePoints: cache.encoder(full),
    });
    expect(initial.transfer).toHaveLength(10_000);
    expect(work.indexedReads).toBeGreaterThan(0);
    cache.accept(full, { identity: unlockIdentity, modelRevision: 0, type: "model-sync-success" });
    work.indexedReads = 0;
    const moved: IncrementalModelSyncRuntimeRequest = {
      baseModelRevision: 0,
      identity: unlockIdentity,
      modelRevision: 1,
      changedElements: elements.map((element) => ({
        ...element,
        offset: { x: 1, y: 2 },
        pivot: { x: 21, y: 22 },
      })),
      type: "model-sync-incremental",
    };
    const encoded = await encodeRuntimeRequestChunked(moved, {
      ...options,
      reusePoints: cache.encoder(moved),
    });
    expect(encoded.transfer).toHaveLength(0);
    const decoded = decodeRuntimeRequest(encoded.value, cache.resolver(0, executor));
    expect(decoded.type).toBe("model-sync-incremental");
    if (decoded.type !== "model-sync-incremental") throw new Error("Unexpected request.");
    expect(decoded.changedElements).toHaveLength(10_000);
    for (const element of decoded.changedElements!) {
      expect(element.kind === "stroke" && element.points).toBe(points);
    }
    expect(work.indexedReads).toBe(0);
    cache.clear();
    expect(() => decodeRuntimeRequest(encoded.value, cache.resolver(0, executor))).toThrow(
      "acknowledged",
    );
  });
});
