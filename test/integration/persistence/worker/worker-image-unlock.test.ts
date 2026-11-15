import { expect, it, vi } from "vitest";
import type { UnlockRuntimeBatch } from "../../../../src/persistence/worker/runtime/types";
import { legacyImageDocument } from "../../../fixtures/persistence/legacy-image-svg";
import { imageElement } from "../../../fixtures/domain/images";
import { rasterResource } from "../../../fixtures/persistence/image-svg";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
  createWorkerUnlockRequest,
} from "../../../fixtures/persistence/worker-bridge";

it("settles a version 3 image unlock through the host bridge after acknowledging its element batch", async () => {
  const saved = legacyImageDocument(3);
  const asset = rasterResource();
  const element = {
    ...imageElement(),
    assetId: asset.id,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
  const { clientEndpoint, detach } = createWorkerBridgeHarness();
  const client = createWorkerBridgeClient(clientEndpoint);
  const unlockBatch = vi.fn<(batch: UnlockRuntimeBatch) => void>();
  try {
    const unlocked = await client.execute(createWorkerUnlockRequest(saved.bytes), { unlockBatch });
    expect(unlocked).toMatchObject({
      type: "unlock-success",
      sourceVersion: 3,
      snapshot: { version: 5, imageResources: [asset], elementCount: 2 },
    });
    expect(unlockBatch.mock.calls[0]?.[0].elements).toHaveLength(2);
    expect(unlockBatch.mock.calls[0]?.[0].elements[0]).toEqual(element);
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
