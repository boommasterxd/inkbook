import { describe, expect, it, vi } from "vitest";

import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/worker-bridge";
import { createWorkerBridgeHarness } from "../../../fixtures/persistence/worker-bridge";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";

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
