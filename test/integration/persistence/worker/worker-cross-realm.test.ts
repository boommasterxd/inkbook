import { describe, expect, it, vi } from "vitest";

import { validateInkPageV1, type StrokeElementV1 } from "../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import type { UnlockRuntimeBatch } from "../../../../src/persistence/worker/runtime/types";
import {
  createOneStrokeWorkerSnapshot,
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
  createWorkerUnlockRequest,
  serializeOneStrokeWorkerSnapshot,
} from "../../../fixtures/persistence/worker-bridge";
import { installPopoutWorkerTransport } from "../../../fixtures/persistence/worker-popout-realm";
import {
  coordinateSystem,
  line,
  rectangle,
  snapshot,
  stroke,
  table,
} from "../../../unit/domain/schema/fixtures";

describe("document worker pop-out realm", () => {
  it("adopts transferred stroke buffers and exports through a worker owned by another window", async () => {
    const { clientEndpoint, hostEndpoint, detach, runtime } = createWorkerBridgeHarness();
    const client = createWorkerBridgeClient(clientEndpoint);
    const source = snapshot([stroke(), rectangle(), line(), coordinateSystem(), table()]);
    const serialized = serializeInkbookDocument(source);
    if (!serialized.ok) throw new Error(serialized.error.message);
    const receivedBuffers = installPopoutWorkerTransport(hostEndpoint);
    const unlockBatch = vi.fn<(batch: UnlockRuntimeBatch) => void>();
    try {
      const unlocked = await client.execute(
        createWorkerUnlockRequest(new TextEncoder().encode(serialized.value.svg)),
        { unlockBatch },
      );
      expect(unlocked).toMatchObject({ type: "unlock-success" });
      if (unlocked.type !== "unlock-success") throw new Error("Expected unlock success.");
      expect(Reflect.getPrototypeOf(unlocked.snapshot.page)).not.toBe(Object.prototype);
      expect(validateInkPageV1(unlocked.snapshot.page)).toMatchObject({ ok: true });
      expect(unlockBatch.mock.calls[0]![0].elements.slice(1)).toEqual(source.elements.slice(1));
      const points = (unlockBatch.mock.calls[0]![0].elements[0] as StrokeElementV1).points;
      expect(points).toBeInstanceOf(Float64Array);
      expect((points as unknown as Float64Array).buffer).toBe(receivedBuffers[0]);
      expect(receivedBuffers[0]).not.toBeInstanceOf(ArrayBuffer);
      expect(clientEndpoint.sentMessages).toContainEqual({
        accepted: true,
        batchIndex: 0,
        requestId: 1,
        type: "inkbook-worker-batch-acknowledgement",
      });

      const exported = await client.execute({
        baseModelRevision: 0,
        exportGeneration: 1,
        modelRevision: 0,
        sessionId: "session-a",
        type: "export-incremental",
        workerEpoch: 1,
      });
      expect(exported).toMatchObject({ type: "export-success" });
      if (exported.type !== "export-success") throw new Error("Expected export success.");
      client.acknowledgeExport(exported, true);
      expect(runtime.instrumentation).toMatchObject({
        retainedCompleteOutputBytes: 0,
        unacknowledgedExports: 0,
      });
    } finally {
      client.terminate();
      detach();
      vi.restoreAllMocks();
    }
  });
});

describe("document worker pop-out clipboard realm", () => {
  it("adopts clipboard text, decoded samples and paste plans from the owning window", async () => {
    const { clientEndpoint, hostEndpoint, detach } = createWorkerBridgeHarness();
    const client = createWorkerBridgeClient(clientEndpoint);
    const receivedBuffers = installPopoutWorkerTransport(hostEndpoint);
    const identity = {
      operationId: 2,
      purpose: "clipboard" as const,
      sessionId: "session-a",
      workerEpoch: 1,
    };
    try {
      await client.execute(
        createWorkerUnlockRequest(new TextEncoder().encode(serializeOneStrokeWorkerSnapshot().svg)),
      );
      const copied = await client.execute({
        basisRevision: 0,
        identity,
        selectedIds: [createOneStrokeWorkerSnapshot().elements[0]!.id],
        type: "clipboard-encode",
      });
      if (copied.type !== "clipboard-encode-success" || !copied.result.ok)
        throw new Error("Expected clipboard encoding success.");
      const candidates = { customText: copied.result.value.customText };
      const decoded = await client.execute({
        basisRevision: 0,
        candidates,
        identity: { ...identity, operationId: 3 },
        type: "clipboard-decode",
      });
      if (decoded.type !== "clipboard-decode-success" || !decoded.result.ok)
        throw new Error("Expected clipboard decoding success.");
      const stroke = decoded.result.value.payload.elements[0]!.element;
      if (stroke.kind !== "stroke") throw new Error("Expected decoded stroke.");
      expect(stroke.points).toBeInstanceOf(Float64Array);
      expect(receivedBuffers).toContain((stroke.points as unknown as Float64Array).buffer);
      expect(decoded.result.value.customText).toBe(candidates.customText);

      const pasted = await client.execute({
        basisRevision: 0,
        candidates,
        commandTimestamp: 100,
        identity: { ...identity, operationId: 4 },
        invocation: { kind: "toolbar", visibleCanvasCenter: { x: 100, y: 100 } },
        type: "clipboard-plan-paste",
      });
      if (pasted.type !== "clipboard-plan-paste-success" || !pasted.result.ok)
        throw new Error("Expected clipboard paste plan success.");
      const planned = pasted.result.value.elements[0]!;
      if (planned.kind !== "stroke") throw new Error("Expected planned stroke.");
      expect(planned.points).toEqual(Array.from(stroke.points));
      expect(planned.id).not.toBe(createOneStrokeWorkerSnapshot().elements[0]!.id);
      expect(pasted.result.value.selectedIds).toEqual([planned.id]);
    } finally {
      client.terminate();
      detach();
      vi.restoreAllMocks();
    }
  });
});
