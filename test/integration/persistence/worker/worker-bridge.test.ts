import { describe, expect, it, vi } from "vitest";

import { encodeRuntimeSelection } from "../../../../src/persistence/clipboard/codec";
import { encodeRuntimeRequest } from "../../../../src/persistence/worker/runtime/wire-codec";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/worker-bridge";
import {
  createOneStrokeWorkerSnapshot,
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
  createWorkerUnlockRequest,
  serializeOneStrokeWorkerSnapshot,
} from "../../../fixtures/persistence/worker-bridge";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";

const bridgeHarness = createWorkerBridgeHarness;
const oneStrokeSnapshot = createOneStrokeWorkerSnapshot;
const unlockRequest = createWorkerUnlockRequest;

function serializedBridgeHarness() {
  const serialized = serializeOneStrokeWorkerSnapshot();
  const { clientEndpoint, detach, hostEndpoint, runtime } = bridgeHarness();
  const client = createWorkerBridgeClient(clientEndpoint);
  return { client, clientEndpoint, detach, hostEndpoint, runtime, serialized };
}

describe("document worker bridge", () => {
  it("creates one worker endpoint and executes requests in the hosted runtime", async () => {
    const { clientEndpoint, detach } = bridgeHarness();
    let creations = 0;
    const client = new WorkerDocumentRuntimePort(
      () => {
        creations += 1;
        return clientEndpoint;
      },
      {
        workScheduler: new TestWorkScheduler(),
        frameIntervalMilliseconds: () => 1_000 / 60,
      },
    );

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
    const { client, clientEndpoint, detach, runtime, serialized } = serializedBridgeHarness();
    await client.execute(unlockRequest(new TextEncoder().encode(serialized.svg)));

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
    const client = createWorkerBridgeClient(clientEndpoint);
    const input = new TextEncoder().encode("not-svg");

    await client.execute(unlockRequest(input));

    expect(clientEndpoint.transfers.filter((buffers) => buffers.length > 0)).toEqual([
      [input.buffer],
    ]);
    client.terminate();
    detach();
  });

  it("waits for unlock-batch adoption before returning the terminal header", async () => {
    const { client, clientEndpoint, detach, hostEndpoint, serialized } = serializedBridgeHarness();
    const batches: number[] = [];

    const result = await client.execute(unlockRequest(new TextEncoder().encode(serialized.svg)), {
      unlockBatch: async (batch) => {
        await Promise.resolve();
        batches.push(batch.elements.length);
      },
    });

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
    const { client, clientEndpoint, detach } = serializedBridgeHarness();

    await expect(
      client.execute(
        unlockRequest(new TextEncoder().encode(serializeOneStrokeWorkerSnapshot().svg)),
        {
          unlockBatch: () => Promise.reject(new Error("index construction failed")),
        },
      ),
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
    const { client, clientEndpoint, detach } = serializedBridgeHarness();
    const recoveryRequest = {
      ...unlockRequest(new TextEncoder().encode(serializeOneStrokeWorkerSnapshot().svg)),
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

describe("document worker bridge timeout controls", () => {
  it("terminates once on timeout, reports recovery context, and ignores a late result", async () => {
    const clientEndpoint = new TestWorkerEndpoint();
    const hostEndpoint = new TestWorkerEndpoint();
    hostEndpoint.peer = clientEndpoint;
    const failures: unknown[] = [];
    const client = new WorkerDocumentRuntimePort(() => clientEndpoint, {
      workScheduler: new TestWorkScheduler(),
      frameIntervalMilliseconds: () => 1_000 / 60,
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
    expect(failures).toEqual([{ kind: "timeout", phase: "timeout", request }]);

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
});

describe("document worker scene cancellation", () => {
  it("ignores foreign scene cancellation identities and settles only the exact operation", async () => {
    const { clientEndpoint, detach } = bridgeHarness();
    const client = createWorkerBridgeClient(clientEndpoint);
    const snapshot = oneStrokeSnapshot();
    const identity = {
      operationId: 8,
      purpose: "background" as const,
      sessionId: "session-a",
      workerEpoch: 1,
    };
    await client.execute({
      baseModelRevision: null,
      identity,
      modelRevision: 0,
      snapshot,
      type: "model-sync-full",
    });
    client.setLiveInputActive(true);
    const request = {
      basisRevision: 0,
      identity,
      ids: [snapshot.elements[0]!.id],
      type: "prepare-scene-paths" as const,
    };
    const pending = client.execute(request);
    const settled = vi.fn();
    void pending.then(settled, settled);

    for (const foreign of [
      { ...identity, sessionId: "session-b" },
      { ...identity, workerEpoch: 2 },
      { ...identity, purpose: "verification" as const },
      { ...identity, operationId: 9 },
    ]) {
      client.cancelScenePreparation(foreign);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
    }

    client.setLiveInputActive(false);
    await expect(pending).resolves.toMatchObject({
      identity,
      type: "prepare-scene-paths-success",
      paths: [{ id: snapshot.elements[0]!.id }],
    });
    expect(settled).toHaveBeenCalledOnce();
    client.setLiveInputActive(true);
    const cancelled = client.execute(request);
    const cancellation = expect(cancelled).resolves.toEqual({
      code: "scene-preparation-cancelled",
      identity,
      retryable: true,
      type: "runtime-failure",
    });
    client.cancelScenePreparation(identity);
    await cancellation;
    client.terminate();
    detach();
  });
});

describe("document worker bridge input controls", () => {
  it("forwards live-input and prewarm controls without creating operation identities", () => {
    const clientEndpoint = new TestWorkerEndpoint();
    const client = createWorkerBridgeClient(clientEndpoint);

    client.setLiveInputActive(true);
    client.requestPrewarm();
    client.setLiveInputActive(false);

    expect(clientEndpoint.sentMessages).toEqual([
      {
        action: "set-profile",
        frameIntervalMilliseconds: 1_000 / 60,
        sliceMilliseconds: 8,
        type: "inkbook-worker-control",
      },
      { action: "set-live-input", active: true, type: "inkbook-worker-control" },
      { action: "prewarm", type: "inkbook-worker-control" },
      { action: "set-live-input", active: false, type: "inkbook-worker-control" },
    ]);
    client.terminate();
  });

  it("pauses even a small request before main-thread preparation while input is live", async () => {
    const clientEndpoint = new TestWorkerEndpoint();
    const client = createWorkerBridgeClient(clientEndpoint);
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
      {
        action: "set-profile",
        frameIntervalMilliseconds: 1_000 / 60,
        sliceMilliseconds: 8,
        type: "inkbook-worker-control",
      },
      { action: "set-live-input", active: true, type: "inkbook-worker-control" },
    ]);

    client.setLiveInputActive(false);
    await vi.waitFor(() => {
      expect(clientEndpoint.sentMessages).toHaveLength(4);
    });
    expect(clientEndpoint.sentMessages[3]).toMatchObject({ type: "inkbook-worker-request" });

    client.terminate();
    await expect(settlement).resolves.toBeInstanceOf(Error);
  });
});

describe("document worker clipboard bridge", () => {
  it("adopts one canonical text transfer and releases each completed request", async () => {
    const document = oneStrokeSnapshot();
    const { client, detach, hostEndpoint, serialized } = serializedBridgeHarness();
    await client.execute(unlockRequest(new TextEncoder().encode(serialized.svg)));

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
    const expected = encodeRuntimeSelection(document.elements, new Set([document.elements[0]!.id]));
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
