import { describe, expect, it, vi } from "vitest";
import { ModelPointReferences } from "../../../../src/persistence/worker/runtime/bridge/model-point-references";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
  createWorkerUnlockRequest,
  serializeOneStrokeWorkerSnapshot,
} from "../../../fixtures/persistence/worker-bridge";

describe("settled unlock adoption callbacks", () => {
  it.each(["resolve", "reject"] as const)(
    "ignores a late observer %s after termination without retaining points or acknowledging",
    async (outcome) => {
      const harness = createWorkerBridgeHarness();
      const client = createWorkerBridgeClient(harness.clientEndpoint);
      const stages = vi.spyOn(ModelPointReferences.prototype, "stageUnlock");
      const clears = vi.spyOn(ModelPointReferences.prototype, "clear");
      const publication = vi.spyOn(harness.clientEndpoint, "postMessage");
      let resolveAdoption!: () => void;
      let rejectAdoption!: (error: Error) => void;
      let notifyStarted!: () => void;
      const adoption = new Promise<void>((resolve, reject) => {
        resolveAdoption = resolve;
        rejectAdoption = reject;
      });
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      const request = createWorkerUnlockRequest(
        new TextEncoder().encode(serializeOneStrokeWorkerSnapshot().svg),
      );
      try {
        const pending = client.execute(request, {
          unlockBatch: () => {
            notifyStarted();
            return adoption;
          },
        });
        const rejected = expect(pending).rejects.toThrow("Document worker failed");
        await started;
        const references = clears.mock.contexts[0] as ModelPointReferences;
        client.terminate();
        await rejected;
        const stagedBefore = stages.mock.calls.length;
        const publicationsBefore = publication.mock.calls.length;
        const clearsBefore = clears.mock.calls.length;
        if (outcome === "resolve") resolveAdoption();
        else rejectAdoption(new Error("late adoption rejection"));
        await adoption.catch(() => undefined);
        await Promise.resolve();
        expect(stages).toHaveBeenCalledTimes(stagedBefore);
        expect(publication).toHaveBeenCalledTimes(publicationsBefore);
        expect(clears).toHaveBeenCalledTimes(clearsBefore);
        expect(harness.clientEndpoint.sentMessages).not.toContainEqual(
          expect.objectContaining({
            type: "inkbook-worker-batch-acknowledgement",
          }),
        );
        expect(() =>
          references.resolver(0, request.identity)("00000000-0000-4000-8000-000000000001"),
        ).toThrow("acknowledged model");
      } finally {
        resolveAdoption();
        client.terminate();
        harness.detach();
        harness.runtime.terminate();
        vi.restoreAllMocks();
      }
    },
  );
});
