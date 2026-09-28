import { describe, expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/worker-bridge";
import {
  createOneStrokeWorkerSnapshot,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";

function fullExportRequest() {
  return {
    baseModelRevision: null,
    exportGeneration: 1,
    modelRevision: 0,
    sessionId: "session-a",
    snapshot: createOneStrokeWorkerSnapshot(),
    type: "export-full" as const,
    workerEpoch: 1,
  };
}

describe("document worker export admission", () => {
  it("uses frame admission for incremental export and background admission for verification", async () => {
    const endpoint = new TestWorkerEndpoint();
    const scheduler = new TestWorkScheduler({
      shouldYield: () => true,
      nextFrame: async () => undefined,
      checkpoint: async () => undefined,
    });
    const nextFrame = vi.spyOn(scheduler, "nextFrame");
    const checkpoint = vi.spyOn(scheduler, "checkpoint");
    const client = new WorkerDocumentRuntimePort(() => endpoint, {
      workScheduler: scheduler,
      frameIntervalMilliseconds: () => 1_000 / 120,
    });
    const exportPending = client.execute({
      baseModelRevision: 0,
      exportGeneration: 1,
      modelRevision: 1,
      sessionId: "session-a",
      type: "export-incremental",
      workerEpoch: 1,
    });
    await vi.waitFor(() =>
      expect(endpoint.sentMessages).toContainEqual(
        expect.objectContaining({ type: "inkbook-worker-request" }),
      ),
    );
    expect(nextFrame).toHaveBeenCalledWith(expect.any(AbortSignal), "frame");
    const frameCalls = nextFrame.mock.calls.length;
    const verificationPending = client.execute({
      identity: { operationId: 2, purpose: "verification", sessionId: "session-a", workerEpoch: 1 },
      input: "untrusted",
      type: "verify-output",
    });
    await vi.waitFor(() =>
      expect(endpoint.sentMessages).toContainEqual(
        expect.objectContaining({ requestId: 2, type: "inkbook-worker-request" }),
      ),
    );
    expect(nextFrame).toHaveBeenCalledTimes(frameCalls);
    expect(checkpoint).toHaveBeenCalled();
    client.terminate();
    await expect(exportPending).rejects.toThrow("Document worker failed");
    await expect(verificationPending).rejects.toThrow("Document worker failed");
  });

  it("dispatches an export without a frame wait while budget is free and respects live input", async () => {
    const endpoint = new TestWorkerEndpoint();
    const scheduler = new TestWorkScheduler({ shouldYield: () => false });
    const nextFrame = vi.spyOn(scheduler, "nextFrame");
    const client = new WorkerDocumentRuntimePort(() => endpoint, {
      workScheduler: scheduler,
      frameIntervalMilliseconds: () => 1_000 / 120,
    });
    client.setLiveInputActive(true);
    const pending = client.execute(fullExportRequest());
    await Promise.resolve();
    expect(endpoint.sentMessages).not.toContainEqual(
      expect.objectContaining({ type: "inkbook-worker-request" }),
    );
    client.setLiveInputActive(false);
    await vi.waitFor(() =>
      expect(endpoint.sentMessages).toContainEqual(
        expect.objectContaining({ type: "inkbook-worker-request" }),
      ),
    );
    expect(nextFrame).not.toHaveBeenCalled();
    client.terminate();
    await expect(pending).rejects.toThrow("Document worker failed");
  });

  it("cancels a waiting export before wire publication on termination", async () => {
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    const endpoint = new TestWorkerEndpoint();
    const client = new WorkerDocumentRuntimePort(() => endpoint, {
      workScheduler: scheduler,
      frameIntervalMilliseconds: () => host.frameInterval,
    });
    scheduler.deadline();
    host.time = host.budget;
    const pending = client.execute(fullExportRequest());
    expect(host.pendingFrames).toBe(1);
    client.terminate();
    await expect(pending).rejects.toThrow("Document worker failed");
    expect(endpoint.sentMessages).not.toContainEqual(
      expect.objectContaining({ type: "inkbook-worker-request" }),
    );
    expect(host.pendingFrames).toBe(0);
    scheduler.dispose();
    expect(host.pendingTimers).toBe(0);
  });
});

describe("document worker scheduling controls", () => {
  it("applies only finite positive scheduling profiles at the worker host", () => {
    const { clientEndpoint, detach, runtime } = createWorkerBridgeHarness();
    const updateProfile = vi.spyOn(runtime, "setSchedulingProfile");

    clientEndpoint.postMessage({
      action: "set-profile",
      frameIntervalMilliseconds: 1_000 / 120,
      sliceMilliseconds: 4.58,
      type: "inkbook-worker-control",
    });
    clientEndpoint.postMessage({
      action: "set-profile",
      frameIntervalMilliseconds: 0,
      sliceMilliseconds: 4.58,
      type: "inkbook-worker-control",
    });
    clientEndpoint.postMessage({
      action: "set-profile",
      frameIntervalMilliseconds: 1_000 / 120,
      sliceMilliseconds: Number.NaN,
      type: "inkbook-worker-control",
    });

    expect(updateProfile).toHaveBeenCalledOnce();
    expect(updateProfile).toHaveBeenCalledWith(4.58, 1_000 / 120);
    detach();
  });

  it("publishes each changed display profile once and unsubscribes on termination", () => {
    const endpoint = new TestWorkerEndpoint();
    const listeners = new Set<() => void>();
    let sliceMilliseconds = 5;
    let frameIntervalMilliseconds = 12;
    const client = new WorkerDocumentRuntimePort(() => endpoint, {
      workScheduler: new TestWorkScheduler({ budgetMs: () => sliceMilliseconds }),
      frameIntervalMilliseconds: () => frameIntervalMilliseconds,
      subscribeSchedulingProfile: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    for (const listener of listeners) listener();
    sliceMilliseconds = 3;
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    frameIntervalMilliseconds = 8;
    for (const listener of listeners) listener();

    expect(endpoint.sentMessages).toEqual([
      {
        action: "set-profile",
        frameIntervalMilliseconds: 12,
        sliceMilliseconds: 5,
        type: "inkbook-worker-control",
      },
      {
        action: "set-profile",
        frameIntervalMilliseconds: 12,
        sliceMilliseconds: 3,
        type: "inkbook-worker-control",
      },
      {
        action: "set-profile",
        frameIntervalMilliseconds: 8,
        sliceMilliseconds: 3,
        type: "inkbook-worker-control",
      },
    ]);
    client.terminate();
    expect(listeners.size).toBe(0);
  });
});
