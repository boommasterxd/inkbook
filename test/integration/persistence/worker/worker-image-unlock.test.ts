import { expect, it, vi } from "vitest";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import type { UnlockRuntimeBatch } from "../../../../src/persistence/worker/runtime/types";
import { validImageFixture } from "../../../fixtures/persistence/images";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
  createWorkerUnlockRequest,
} from "../../../fixtures/persistence/worker-bridge";

it("settles a version 3 image unlock through the host bridge after acknowledging its element batch", async () => {
  const { asset, element } = await validImageFixture();
  const saved = serializeInkbookDocument({
    ...createWorkerSnapshot([element]),
    version: 3,
    imageResources: [asset],
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const { clientEndpoint, detach } = createWorkerBridgeHarness();
  const client = createWorkerBridgeClient(clientEndpoint);
  const unlockBatch = vi.fn<(batch: UnlockRuntimeBatch) => void>();
  try {
    const unlocked = await client.execute(
      createWorkerUnlockRequest(new TextEncoder().encode(saved.value.svg)),
      { unlockBatch },
    );
    expect(unlocked).toMatchObject({
      type: "unlock-success",
      sourceVersion: 3,
      snapshot: { version: 3, imageResources: [asset], elementCount: 1 },
    });
    expect(unlockBatch.mock.calls[0]?.[0].elements).toEqual([element]);
    expect(clientEndpoint.sentMessages).toContainEqual({
      type: "inkbook-worker-batch-acknowledgement",
      requestId: 1,
      batchIndex: 0,
      accepted: true,
    });
  } finally {
    client.terminate();
    detach();
  }
});
