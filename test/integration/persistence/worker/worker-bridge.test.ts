import { describe, expect, it, vi } from "vitest";

import { encodeSelection } from "../../../../src/persistence/clipboard/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import {
  attachDocumentWorkerHost,
  DocumentWorkerRuntime,
  encodeRuntimeRequest,
  encodeUnlockBatch,
  WorkerDocumentRuntimePort,
} from "../../../../src/persistence/worker/runtime/public";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

function bridgeHarness() {
  const clientEndpoint = new TestWorkerEndpoint();
  const hostEndpoint = new TestWorkerEndpoint();
  clientEndpoint.peer = hostEndpoint;
  hostEndpoint.peer = clientEndpoint;
  const runtime = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
  const detach = attachDocumentWorkerHost(hostEndpoint, runtime);
  return { clientEndpoint, detach, hostEndpoint, runtime };
}

function oneStrokeSnapshot() {
  return createWorkerSnapshot([createTestStroke()]);
}

function unlockRequest(input: Uint8Array) {
  return {
    identity: {
      operationId: 1,
      purpose: "unlock" as const,
      sessionId: "session-a",
      workerEpoch: 1,
    },
    input,
    type: "unlock" as const,
  };
}

function serializedBridgeHarness() {
  const serialized = serializeInkbookDocument(oneStrokeSnapshot());
  if (!serialized.ok) throw new Error(serialized.error.message);
  const { clientEndpoint, detach } = bridgeHarness();
  const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
  return { client, clientEndpoint, detach, serialized };
}

function unlockBatchBoundaryHarness() {
  const clientEndpoint = new TestWorkerEndpoint();
  const hostEndpoint = new TestWorkerEndpoint();
  clientEndpoint.peer = hostEndpoint;
  hostEndpoint.peer = clientEndpoint;
  const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
  const observer = { unlockBatch: vi.fn() };
  const request = unlockRequest(new Uint8Array());
  const pending = client.execute(request, observer);
  return { client, clientEndpoint, hostEndpoint, observer, pending };
}

async function expectRejectedUnlockBatch(
  harness: ReturnType<typeof unlockBatchBoundaryHarness>,
  batch: ReturnType<typeof encodeUnlockBatch>["value"],
) {
  harness.hostEndpoint.postMessage({
    batch,
    requestId: 1,
    type: "inkbook-worker-unlock-batch",
  });

  await expect(harness.pending).rejects.toThrow("batch adoption failed");
  expect(harness.observer.unlockBatch).not.toHaveBeenCalled();
  expect(harness.clientEndpoint.sentMessages).toContainEqual({
    accepted: false,
    batchIndex: 0,
    requestId: 1,
    type: "inkbook-worker-batch-acknowledgement",
  });
  harness.client.terminate();
}

describe("document worker bridge", () => {
  it("creates one worker endpoint and executes requests in the hosted runtime", async () => {
    const { clientEndpoint, detach } = bridgeHarness();
    let creations = 0;
    const client = new WorkerDocumentRuntimePort(() => {
      creations += 1;
      return clientEndpoint;
    });

    const result = await client.execute({
      identity: {
        operationId: 1,
        purpose: "verification",
        sessionId: "session-a",
        workerEpoch: 1,
      },
      input: "not-svg",
      type: "verify-output",
    });

    expect(result).toMatchObject({
      persisted: { type: "unreadable" },
      type: "verify-output-success",
    });
    expect(creations).toBe(1);
    client.terminate();
    expect(clientEndpoint.terminated).toBe(true);
    detach();
  });
});

describe("document worker export bridge", () => {
  it("acknowledges exact transferred exports and closes worker result lifetime", async () => {
    const serialized = serializeInkbookDocument(oneStrokeSnapshot());
    if (!serialized.ok) throw new Error(serialized.error.message);
    const { clientEndpoint, detach, runtime } = bridgeHarness();
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
    await client.execute(unlockRequest(new TextEncoder().encode(serialized.value.svg)));

    const result = await client.execute({
      baseModelRevision: 0,
      exportGeneration: 1,
      modelRevision: 0,
      sessionId: "session-a",
      type: "export-incremental",
      workerEpoch: 1,
    });
    expect(result).toMatchObject({ type: "export-success" });
    if (result.type !== "export-success") throw new Error("Expected export success.");
    expect(clientEndpoint.sentMessages).not.toContainEqual(
      expect.objectContaining({ type: "inkbook-worker-export-acknowledgement" }),
    );
    client.acknowledgeExport(result, true);

    expect(clientEndpoint.sentMessages).toContainEqual({
      accepted: true,
      exportGeneration: 1,
      modelRevision: 0,
      requestId: 2,
      sessionId: "session-a",
      type: "inkbook-worker-export-acknowledgement",
      workerEpoch: 1,
    });
    expect(runtime.instrumentation).toMatchObject({
      retainedCompleteOutputBytes: 0,
      unacknowledgedExports: 0,
    });
    client.terminate();
    detach();
  });

  it("expires an unacknowledged export without retaining complete output", async () => {
    const { clientEndpoint, detach, hostEndpoint, runtime } = bridgeHarness();
    const encoded = encodeRuntimeRequest({
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: 0,
      sessionId: "session-a",
      snapshot: oneStrokeSnapshot(),
      type: "export-full",
      workerEpoch: 1,
    });

    clientEndpoint.postMessage({
      request: encoded.value,
      requestId: 1,
      type: "inkbook-worker-request",
    });
    await vi.waitFor(() => {
      expect(runtime.instrumentation.unacknowledgedExports).toBe(1);
      expect(hostEndpoint.sentMessages).toContainEqual(
        expect.objectContaining({ type: "inkbook-worker-result" }),
      );
    });
    hostEndpoint.fireTimeouts(30_000);

    expect(runtime.instrumentation).toMatchObject({
      retainedCompleteOutputBytes: 0,
      unacknowledgedExports: 0,
    });
    detach();
  });
});

describe("document worker unlock bridge", () => {
  it("transfers the exact unlock input buffer", async () => {
    const { clientEndpoint, detach } = bridgeHarness();
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
    const input = new TextEncoder().encode("not-svg");

    await client.execute(unlockRequest(input));

    expect(clientEndpoint.transfers).toEqual([[input.buffer]]);
    client.terminate();
    detach();
  });

  it("waits for unlock-batch adoption before returning the terminal header", async () => {
    const serialized = serializeInkbookDocument(oneStrokeSnapshot());
    if (!serialized.ok) throw new Error(serialized.error.message);
    const { clientEndpoint, detach, hostEndpoint } = bridgeHarness();
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
    const batches: number[] = [];

    const result = await client.execute(
      unlockRequest(new TextEncoder().encode(serialized.value.svg)),
      {
        unlockBatch: async (batch) => {
          await Promise.resolve();
          batches.push(batch.elements.length);
        },
      },
    );

    expect(batches).toEqual([1]);
    expect(result).toMatchObject({
      snapshot: { batchCount: 1, elementCount: 1, revision: 0 },
      type: "unlock-success",
    });
    expect(hostEndpoint.transfers.some(([value]) => value instanceof ArrayBuffer)).toBe(true);
    expect(clientEndpoint.sentMessages).toContainEqual({
      accepted: true,
      batchIndex: 0,
      requestId: 1,
      type: "inkbook-worker-batch-acknowledgement",
    });
    client.terminate();
    detach();
  });

  it("rejects and acknowledges a failed unlock-batch adoption without hanging the host", async () => {
    const { client, clientEndpoint, detach, serialized } = serializedBridgeHarness();

    await expect(
      client.execute(unlockRequest(new TextEncoder().encode(serialized.value.svg)), {
        unlockBatch: () => Promise.reject(new Error("index construction failed")),
      }),
    ).rejects.toThrow("batch adoption failed");
    expect(clientEndpoint.sentMessages).toContainEqual({
      accepted: false,
      batchIndex: 0,
      requestId: 1,
      type: "inkbook-worker-batch-acknowledgement",
    });
    client.terminate();
    detach();
  });
});

describe("document worker recovery hydration bridge", () => {
  it("adopts recovery hydration batches through the worker port and bridge", async () => {
    const { client, clientEndpoint, detach, serialized } = serializedBridgeHarness();
    const recoveryRequest = {
      ...unlockRequest(new TextEncoder().encode(serialized.value.svg)),
      identity: {
        operationId: 2,
        purpose: "recovery" as const,
        sessionId: "session-a",
        workerEpoch: 1,
      },
    };
    const batches: number[] = [];

    const result = await client.execute(recoveryRequest, {
      unlockBatch: (batch) => {
        expect(batch.identity).toEqual(recoveryRequest.identity);
        batches.push(batch.elements.length);
      },
    });

    expect(batches).toEqual([1]);
    expect(result).toMatchObject({
      identity: recoveryRequest.identity,
      snapshot: { batchCount: 1, elementCount: 1, revision: 0 },
      type: "unlock-success",
    });
    expect(clientEndpoint.sentMessages).toContainEqual({
      accepted: true,
      batchIndex: 0,
      requestId: 1,
      type: "inkbook-worker-batch-acknowledgement",
    });
    client.terminate();
    detach();
  });
});

describe("document worker bridge runtime controls", () => {
  it("terminates once on timeout, reports recovery context, and ignores a late result", async () => {
    const clientEndpoint = new TestWorkerEndpoint();
    const hostEndpoint = new TestWorkerEndpoint();
    hostEndpoint.peer = clientEndpoint;
    const failures: unknown[] = [];
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint, {
      onExecutorFailure: (failure) => failures.push(failure),
      requestTimeoutMilliseconds: 10,
    });
    const request = {
      identity: {
        operationId: 7,
        purpose: "verification" as const,
        sessionId: "session-a",
        workerEpoch: 1,
      },
      input: "not-svg",
      type: "verify-output" as const,
    };

    await expect(client.execute(request)).rejects.toThrow("timed out");
    expect(clientEndpoint.terminated).toBe(true);
    expect(failures).toEqual([{ kind: "timeout", request }]);

    hostEndpoint.postMessage({
      requestId: 1,
      result: {
        identity: request.identity,
        persisted: { type: "unreadable" },
        type: "verify-output-success",
      },
      type: "inkbook-worker-result",
    });
    expect(failures).toHaveLength(1);
  });

  it("forwards live-input and prewarm controls without creating operation identities", () => {
    const clientEndpoint = new TestWorkerEndpoint();
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint);

    client.setLiveInputActive(true);
    client.requestPrewarm();
    client.setLiveInputActive(false);

    expect(clientEndpoint.sentMessages).toEqual([
      { action: "set-live-input", active: true, type: "inkbook-worker-control" },
      { action: "prewarm", type: "inkbook-worker-control" },
      { action: "set-live-input", active: false, type: "inkbook-worker-control" },
    ]);
    client.terminate();
  });

  it("pauses even a small request before main-thread preparation while input is live", async () => {
    const clientEndpoint = new TestWorkerEndpoint();
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
    client.setLiveInputActive(true);
    const pending = client.execute({
      identity: {
        operationId: 8,
        purpose: "verification",
        sessionId: "session-a",
        workerEpoch: 1,
      },
      input: "not-svg",
      type: "verify-output",
    });
    const settlement = pending.catch((error: unknown) => error);

    await Promise.resolve();
    expect(clientEndpoint.sentMessages).toEqual([
      { action: "set-live-input", active: true, type: "inkbook-worker-control" },
    ]);

    client.setLiveInputActive(false);
    await vi.waitFor(() => {
      expect(clientEndpoint.sentMessages).toHaveLength(3);
    });
    expect(clientEndpoint.sentMessages[2]).toMatchObject({ type: "inkbook-worker-request" });

    client.terminate();
    await expect(settlement).resolves.toBeInstanceOf(Error);
  });
});

describe("document worker bridge input boundary", () => {
  it("rejects a forged verification result that does not describe the exact request", async () => {
    const document = serializeInkbookDocument(oneStrokeSnapshot());
    if (!document.ok) throw new Error(document.error.code);
    const clientEndpoint = new TestWorkerEndpoint();
    const hostEndpoint = new TestWorkerEndpoint();
    clientEndpoint.peer = hostEndpoint;
    hostEndpoint.peer = clientEndpoint;
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
    const identity = {
      operationId: 4,
      purpose: "verification" as const,
      sessionId: "session-a",
      workerEpoch: 1,
    };
    const pending = client.execute({ identity, input: document.value.svg, type: "verify-output" });

    hostEndpoint.postMessage({
      requestId: 1,
      result: {
        identity,
        persisted: { outputHash: "0".repeat(64), revision: 0, type: "confirmed" },
        type: "verify-output-success",
      },
      type: "inkbook-worker-result",
    });

    await expect(pending).rejects.toThrow("invalid result");
    client.terminate();
  });

  it("rejects an oversized unlock batch before observer adoption", async () => {
    const harness = unlockBatchBoundaryHarness();
    const encoded = encodeUnlockBatch({
      batchIndex: 0,
      elements: Array.from({ length: 257 }, () => oneStrokeSnapshot().elements[0]!),
      identity: unlockRequest(new Uint8Array()).identity,
    });

    await expectRejectedUnlockBatch(harness, encoded.value);
  });

  it("rejects a hydration batch whose identity differs from the pending request", async () => {
    const harness = unlockBatchBoundaryHarness();
    const encoded = encodeUnlockBatch({
      batchIndex: 0,
      elements: oneStrokeSnapshot().elements,
      identity: {
        operationId: 1,
        purpose: "recovery",
        sessionId: "session-a",
        workerEpoch: 1,
      },
    });

    await expectRejectedUnlockBatch(harness, encoded.value);
  });
});

describe("document worker clipboard bridge", () => {
  it("adopts one canonical text transfer and releases each completed request", async () => {
    const document = oneStrokeSnapshot();
    const serialized = serializeInkbookDocument(document);
    if (!serialized.ok) throw new Error(serialized.error.message);
    const { clientEndpoint, detach, hostEndpoint } = bridgeHarness();
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint);
    await client.execute(unlockRequest(new TextEncoder().encode(serialized.value.svg)));

    const copy = (operationId: number) =>
      client.execute({
        basisRevision: 0,
        identity: {
          operationId,
          purpose: "clipboard",
          sessionId: "session-a",
          workerEpoch: 1,
        },
        selectedIds: [document.elements[0]!.id],
        type: "clipboard-encode",
      });
    const first = await copy(2);
    expect(first.type).toBe("clipboard-encode-success");
    if (first.type !== "clipboard-encode-success" || !first.result.ok) {
      throw new Error("Clipboard encoding failed.");
    }
    const expected = encodeSelection(document.elements, new Set([document.elements[0]!.id]));
    if (!expected.ok) throw new Error(expected.error.message);
    expect(first.result.value.customText).toBe(expected.value.customText);
    expect(Object.keys(first.result.value).sort()).toEqual([
      "byteLength",
      "customText",
      "plainText",
    ]);
    const terminalTransfer = hostEndpoint.transfers[hostEndpoint.transfers.length - 1];
    expect(terminalTransfer).toHaveLength(1);
    expect((terminalTransfer?.[0] as ArrayBuffer).byteLength).toBe(first.result.value.byteLength);

    await expect(copy(3)).resolves.toMatchObject({
      result: { ok: true },
      type: "clipboard-encode-success",
    });
    client.terminate();
    detach();
  });
});
