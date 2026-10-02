import { describe, expect, it, vi } from "vitest";

import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { encodeUnlockBatch } from "../../../../src/persistence/worker/runtime/wire-codec";
import {
  createOneStrokeWorkerSnapshot,
  createWorkerBridgeClient,
  createWorkerBridgeEndpoints,
  createWorkerUnlockRequest,
  serializeOneStrokeWorkerSnapshot,
} from "../../../fixtures/persistence/worker-bridge";

function createBoundaryHarness() {
  const { clientEndpoint, hostEndpoint } = createWorkerBridgeEndpoints();
  const client = createWorkerBridgeClient(clientEndpoint);
  const observer = { unlockBatch: vi.fn() };
  const pending = client.execute(createWorkerUnlockRequest(new Uint8Array()), observer);
  return { client, clientEndpoint, hostEndpoint, observer, pending };
}

function oneStrokeDerivations() {
  const validation = validateInkSnapshotV1(createOneStrokeWorkerSnapshot());
  if (!validation.ok) throw new Error(validation.error.message);
  return validation.derivations.elements;
}

async function expectRejectedBatch(
  harness: ReturnType<typeof createBoundaryHarness>,
  batch: ReturnType<typeof encodeUnlockBatch>["value"],
) {
  harness.hostEndpoint.postMessage({ batch, requestId: 1, type: "inkbook-worker-unlock-batch" });
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

describe("document worker bridge input boundary", () => {
  it("rejects malformed verification hash evidence from the owned worker channel", async () => {
    const document = serializeOneStrokeWorkerSnapshot();
    const { clientEndpoint, hostEndpoint } = createWorkerBridgeEndpoints();
    const client = createWorkerBridgeClient(clientEndpoint);
    const identity = {
      operationId: 4,
      purpose: "verification" as const,
      sessionId: "session-a",
      workerEpoch: 1,
    };
    const pending = client.execute({ identity, input: document.svg, type: "verify-output" });

    hostEndpoint.postMessage({
      requestId: 1,
      result: {
        identity,
        persisted: { outputHash: "invalid-hash", revision: 0, type: "confirmed" },
        type: "verify-output-success",
      },
      type: "inkbook-worker-result",
    });

    await expect(pending).rejects.toThrow("invalid result");
    client.terminate();
  });

  it("rejects an oversized unlock batch before observer adoption", async () => {
    const harness = createBoundaryHarness();
    const derivation = oneStrokeDerivations()[0]!;
    const encoded = encodeUnlockBatch({
      batchIndex: 0,
      derivations: Array.from({ length: 257 }, () => derivation),
      elements: Array.from({ length: 257 }, () => createOneStrokeWorkerSnapshot().elements[0]!),
      identity: createWorkerUnlockRequest(new Uint8Array()).identity,
    });

    await expectRejectedBatch(harness, encoded.value);
  });

  it("rejects a hydration batch whose identity differs from the pending request", async () => {
    const harness = createBoundaryHarness();
    const encoded = encodeUnlockBatch({
      batchIndex: 0,
      derivations: oneStrokeDerivations(),
      elements: createOneStrokeWorkerSnapshot().elements,
      identity: {
        ...createWorkerUnlockRequest(new Uint8Array()).identity,
        purpose: "recovery",
      },
    });

    await expectRejectedBatch(harness, encoded.value);
  });
});
