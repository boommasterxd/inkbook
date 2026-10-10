import { describe, expect, it, vi } from "vitest";

import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/worker-bridge";
import {
  createOneStrokeWorkerSnapshot,
  createWorkerBridgeClient,
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

function isExportRequest(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "request" in message &&
    typeof message.request === "object" &&
    message.request !== null &&
    "type" in message.request &&
    message.request.type === "export-full"
  );
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

describe("document worker navigation admission", () => {
  it.each([false, true])(
    "admits navigation paths with reserve=%s while export and drawing gates stay independent",
    async (navigationReserve) => {
      const harness = createWorkerBridgeHarness();
      const client = createWorkerBridgeClient(harness.clientEndpoint);
      const snapshot = createOneStrokeWorkerSnapshot();
      const identity = {
        operationId: 1,
        purpose: "background" as const,
        sessionId: "session-a",
        workerEpoch: 1,
      };
      client.setNavigationActive(true);
      await client.execute({
        baseModelRevision: null,
        identity,
        modelRevision: 0,
        snapshot,
        type: "model-sync-full",
      });
      client.requestPrewarm();
      const exportRequest = fullExportRequest();
      let exported = false;
      const exportPending = client.execute(exportRequest).then((result) => {
        exported = true;
        return result;
      });
      client.setLiveInputActive(true);
      const paths = client.execute({
        basisRevision: 0,
        identity,
        ids: [snapshot.elements[0]!.id],
        ...(navigationReserve ? { speculative: true, navigationReserve: true } : {}),
        type: "prepare-scene-paths",
      });
      await Promise.resolve();
      expect(harness.runtime.instrumentation.shapeBuilds).toBe(0);
      client.setLiveInputActive(false);
      expect((await paths).type).toBe("prepare-scene-paths-success");
      expect(exported).toBe(false);
      expect(harness.runtime.instrumentation.prewarmVisitedElements).toBe(0);
      expect(harness.clientEndpoint.sentMessages.some(isExportRequest)).toBe(false);
      client.setLiveInputActive(true);
      client.setNavigationActive(false);
      await Promise.resolve();
      expect(exported).toBe(false);
      client.setLiveInputActive(false);
      expect((await exportPending).type).toBe("export-success");
      client.terminate();
      harness.detach();
    },
  );
});

describe("document worker navigation adoption", () => {
  it("holds a completed export on the main thread while required navigation paths can settle", async () => {
    const harness = createWorkerBridgeHarness();
    const client = createWorkerBridgeClient(harness.clientEndpoint);
    const post = harness.hostEndpoint.postMessage.bind(harness.hostEndpoint);
    const intercept = vi
      .spyOn(harness.hostEndpoint, "postMessage")
      .mockImplementation((message, transfer) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "result" in message &&
          typeof message.result === "object" &&
          message.result !== null &&
          "type" in message.result &&
          message.result.type === "export-success-wire"
        )
          client.setNavigationActive(true);
        post(message, transfer);
      });
    let adopted = false;
    const pending = client.execute(fullExportRequest()).then((result) => {
      adopted = true;
      return result;
    });
    await vi.waitFor(() => expect(harness.runtime.instrumentation.unacknowledgedExports).toBe(1));
    await Promise.resolve();
    expect(adopted).toBe(false);
    expect(
      (
        await client.execute({
          basisRevision: 0,
          identity: {
            operationId: 1,
            purpose: "background",
            sessionId: "session-a",
            workerEpoch: 1,
          },
          ids: [createOneStrokeWorkerSnapshot().elements[0]!.id],
          type: "prepare-scene-paths",
        })
      ).type,
    ).toBe("prepare-scene-paths-success");
    expect(adopted).toBe(false);
    client.setNavigationActive(false);
    expect((await pending).type).toBe("export-success");
    intercept.mockRestore();
    client.terminate();
    harness.detach();
  });
});

it.each(["required", "drawing", "navigation"] as const)(
  "handles a failed speculative cancellation transport during %s without a synchronous exception",
  async (action) => {
    const harness = createWorkerBridgeHarness();
    const failure = vi.fn();
    const client = new WorkerDocumentRuntimePort(() => harness.clientEndpoint, {
      workScheduler: new TestWorkScheduler(),
      frameIntervalMilliseconds: () => 1_000 / 120,
      onExecutorFailure: failure,
    });
    const post = harness.clientEndpoint.postMessage.bind(harness.clientEndpoint);
    const intercept = vi
      .spyOn(harness.clientEndpoint, "postMessage")
      .mockImplementation((message, transfer) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "action" in message &&
          message.action === "cancel-scene-paths"
        )
          throw new Error("Cancellation transport failed.");
        post(message, transfer);
      });
    const request = {
      basisRevision: 0,
      identity: {
        operationId: 1,
        purpose: "background" as const,
        sessionId: "session-a",
        workerEpoch: 1,
      },
      ids: [createOneStrokeWorkerSnapshot().elements[0]!.id],
      speculative: true,
      type: "prepare-scene-paths" as const,
    };
    const pending = client.execute(request).catch((error: unknown) => error);
    try {
      if (action === "required") {
        let required: Promise<unknown> | undefined;
        expect(() => {
          required = client.execute({ ...request, speculative: false });
        }).not.toThrow();
        await expect(required).rejects.toThrow("request dispatch failed");
        expect(failure).toHaveBeenCalledWith({
          kind: "error",
          phase: "dispatch",
          request: { ...request, speculative: false },
        });
      } else {
        expect(() =>
          action === "drawing" ? client.setLiveInputActive(true) : client.setNavigationActive(true),
        ).not.toThrow();
        expect(failure).toHaveBeenCalledWith({ kind: "error", phase: "dispatch" });
      }
      expect(await pending).toMatchObject({
        code: "scene-preparation-cancelled",
        identity: request.identity,
        retryable: true,
        type: "runtime-failure",
      });
      expect(failure).toHaveBeenCalledOnce();
      expect(harness.clientEndpoint.terminated).toBe(true);
      await expect(client.execute({ ...request, speculative: false })).rejects.toThrow(
        "terminated",
      );
    } finally {
      intercept.mockRestore();
      client.terminate();
      harness.detach();
    }
  },
);

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
