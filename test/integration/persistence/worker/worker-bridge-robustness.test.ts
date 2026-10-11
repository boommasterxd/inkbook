import { afterEach, expect, it, vi } from "vitest";

import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import { WorkerDocumentRuntimePort } from "../../../../src/persistence/worker/runtime/worker-bridge";
import { encodeUnlockBatch } from "../../../../src/persistence/worker/runtime/wire-codec";
import { SessionScenePaths } from "../../../../src/obsidian/embeds/session-scene-paths";
import {
  createWorkerBridgeHarness,
  createWorkerBridgeClient,
  createOneStrokeWorkerSnapshot,
  createWorkerUnlockRequest,
} from "../../../fixtures/persistence/worker-bridge";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";

afterEach(() => vi.useRealTimers());

const identity = {
  sessionId: "session-a",
  workerEpoch: 1,
  operationId: 1,
  purpose: "background" as const,
};
const verification = {
  identity: { ...identity, purpose: "verification" as const },
  input: "not-svg",
  type: "verify-output" as const,
};

function watchdogFixture(workScheduler = new TestWorkScheduler({ now: () => Date.now() })) {
  const endpoint = new TestWorkerEndpoint();
  const client = new WorkerDocumentRuntimePort(() => endpoint, {
    workScheduler,
    frameIntervalMilliseconds: () => 1000 / 60,
    requestTimeoutMilliseconds: 100,
  });
  return { endpoint, client };
}

async function expectCompleteWatchdogBudget(
  endpoint: TestWorkerEndpoint,
  pending: Promise<unknown>,
) {
  await vi.advanceTimersByTimeAsync(99);
  expect(endpoint.terminated).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual(new Error("Document worker request timed out."));
  expect(vi.getTimerCount()).toBe(0);
}

it("keeps the worker alive after exact-identity model conflicts and recovers through a full sync", async () => {
  const harness = createWorkerBridgeHarness();
  const client = createWorkerBridgeClient(harness.clientEndpoint);
  const document = createOneStrokeWorkerSnapshot();
  const full = {
    identity,
    snapshot: document,
    baseModelRevision: null,
    modelRevision: 0,
    type: "model-sync-full" as const,
  };
  try {
    await expect(client.execute(full)).resolves.toMatchObject({ type: "model-sync-success" });
    await expect(
      client.execute({
        identity,
        baseModelRevision: 9,
        modelRevision: 1,
        type: "model-sync-incremental",
      }),
    ).resolves.toMatchObject({
      code: "base-revision-mismatch",
      identity,
      type: "runtime-failure",
    });
    expect(harness.clientEndpoint.terminated).toBe(false);
    await expect(client.execute(full)).resolves.toMatchObject({ type: "model-sync-success" });
  } finally {
    client.terminate();
    harness.detach();
  }
});

it.each(["navigation", "drawing", "required"] as const)(
  "keeps the healthy worker after internal speculative cancellation during %s",
  async (action) => {
    vi.useFakeTimers();
    const harness = createWorkerBridgeHarness();
    const failure = vi.fn();
    const client = new WorkerDocumentRuntimePort(() => harness.clientEndpoint, {
      workScheduler: new TestWorkScheduler(),
      frameIntervalMilliseconds: () => 1000 / 60,
      onExecutorFailure: failure,
    });
    const recover = vi.fn(async () => true);
    const session = new SessionScenePaths({
      disposed: () => false,
      executor: () => client,
      revision: () => 0,
      sessionId: "session-a",
      workerEpoch: () => 1,
      synchronize: async () => true,
      recoverExecutorFailure: recover,
    });
    const document = createOneStrokeWorkerSnapshot();
    const ids = [document.elements[0]!.id];
    const controller = new AbortController();
    const observer = { speculative: true, onProgress: vi.fn(), setRetarget: vi.fn() };
    try {
      await client.execute({
        identity,
        snapshot: document,
        baseModelRevision: null,
        modelRevision: 0,
        type: "model-sync-full",
      });
      const speculative = session.prepare(ids, controller.signal, observer);
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
      if (action === "navigation") client.setNavigationActive(true);
      else if (action === "drawing") client.setLiveInputActive(true);
      const required = client.execute({
        identity: { ...identity, operationId: 20 },
        basisRevision: 0,
        ids,
        type: "prepare-scene-paths",
      });
      expect(await speculative).toBeUndefined();
      expect(controller.signal.aborted).toBe(false);
      expect(recover).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
      expect(observer.setRetarget).toHaveBeenLastCalledWith(undefined);
      if (action === "drawing") client.setLiveInputActive(false);
      await expect(required).resolves.toMatchObject({
        type: "prepare-scene-paths-success",
        paths: [{ id: ids[0] }],
      });
      expect(harness.clientEndpoint.terminated).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.terminate();
      harness.detach();
    }
  },
);

it.each(["cancel", "retarget"] as const)(
  "reports a public %s transport failure without an uncaught exception or retained timer",
  async (action) => {
    vi.useFakeTimers();
    const endpoint = new TestWorkerEndpoint();
    const failure = vi.fn();
    const client = new WorkerDocumentRuntimePort(() => endpoint, {
      workScheduler: new TestWorkScheduler(),
      frameIntervalMilliseconds: () => 1000 / 60,
      onExecutorFailure: failure,
    });
    const request = {
      identity,
      basisRevision: 0,
      ids: ["stroke"],
      type: "prepare-scene-paths" as const,
    };
    const pending = client.execute(request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const post = endpoint.postMessage.bind(endpoint);
    vi.spyOn(endpoint, "postMessage").mockImplementation((message, transfer) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "action" in message &&
        message.action === (action === "cancel" ? "cancel-scene-paths" : "retarget-scene-paths")
      )
        throw new Error("transport failed");
      post(message, transfer);
    });
    expect(() =>
      action === "cancel"
        ? client.cancelScenePreparation(identity)
        : client.retargetScenePreparation(identity, []),
    ).not.toThrow();
    if (action === "cancel")
      expect(await pending).toMatchObject({
        code: "scene-preparation-cancelled",
        identity,
        type: "runtime-failure",
      });
    else expect(await pending).toEqual(new Error("Document worker failed."));
    expect(failure).toHaveBeenCalledWith({ kind: "error", phase: "dispatch" });
    expect(failure).toHaveBeenCalledOnce();
    expect(endpoint.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(client.execute(request)).rejects.toThrow("terminated");
  },
);

it("returns queue backpressure across the worker boundary without terminating admitted work", async () => {
  const harness = createWorkerBridgeHarness();
  const client = createWorkerBridgeClient(harness.clientEndpoint);
  harness.runtime.setNavigationActive(true);
  const pending = Array.from({ length: 4 }, (_, index) =>
    client.execute({
      ...verification,
      identity: { ...verification.identity, operationId: index + 1 },
    }),
  );
  try {
    await expect(
      client.execute({ ...verification, identity: { ...verification.identity, operationId: 5 } }),
    ).resolves.toMatchObject({
      code: "queue-full",
      retryable: true,
      type: "runtime-failure",
    });
    expect(harness.clientEndpoint.terminated).toBe(false);
    expect(harness.runtime.instrumentation.retainedJobs).toBe(4);
    harness.runtime.setNavigationActive(false);
    const results = await Promise.all(pending);
    expect(results.every((result) => result.type === "verify-output-success")).toBe(true);
    expect(harness.runtime.instrumentation.retainedJobs).toBe(0);
  } finally {
    client.terminate();
    harness.detach();
  }
});

it("continues to reject a model failure belonging to a different operation", async () => {
  const endpoint = new TestWorkerEndpoint();
  const sender = new TestWorkerEndpoint();
  sender.peer = endpoint;
  const client = createWorkerBridgeClient(endpoint);
  const request = {
    identity,
    snapshot: createOneStrokeWorkerSnapshot(),
    baseModelRevision: null,
    modelRevision: 0,
    type: "model-sync-full" as const,
  };
  const pending = client.execute(request);
  sender.postMessage({
    requestId: 1,
    type: "inkbook-worker-result",
    result: {
      identity: { ...identity, operationId: 2 },
      code: "base-revision-mismatch",
      retryable: false,
      type: "runtime-failure",
    },
  });
  await expect(pending).rejects.toThrow("invalid result");
  expect(endpoint.terminated).toBe(true);
});

it("excludes explicit input and navigation pauses while preserving the remaining stall deadline", async () => {
  vi.useFakeTimers();
  let workTime = 500;
  const endpoint = new TestWorkerEndpoint();
  const failure = vi.fn();
  const client = new WorkerDocumentRuntimePort(() => endpoint, {
    workScheduler: new TestWorkScheduler({ now: () => workTime }),
    requestTimeoutNow: () => Date.now(),
    frameIntervalMilliseconds: () => 1000 / 60,
    requestTimeoutMilliseconds: 100,
    onExecutorFailure: failure,
  });
  client.setLiveInputActive(true);
  const result = client.execute(verification).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(500);
  expect(endpoint.sentMessages).not.toContainEqual(
    expect.objectContaining({ type: "inkbook-worker-request" }),
  );
  client.setLiveInputActive(false);
  await vi.advanceTimersByTimeAsync(40);
  client.setNavigationActive(true);
  workTime = -500;
  await vi.advanceTimersByTimeAsync(500);
  expect(failure).not.toHaveBeenCalled();
  client.setNavigationActive(false);
  await vi.advanceTimersByTimeAsync(59);
  expect(failure).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual(new Error("Document worker request timed out."));
  expect(failure).toHaveBeenCalledWith({
    kind: "timeout",
    phase: "timeout",
    request: verification,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("excludes waiting for central scheduler admission without changing its work priority", async () => {
  vi.useFakeTimers();
  let blocked = true;
  let resume!: () => void;
  const admission = new Promise<void>((resolve) => (resume = resolve));
  const checkpoint = vi.fn(() => (blocked ? admission : undefined));
  const { endpoint, client } = watchdogFixture(
    new TestWorkScheduler({ now: () => Date.now(), checkpoint }),
  );
  const pending = client.execute(verification).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(500);
  expect(endpoint.terminated).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  blocked = false;
  resume();
  await expectCompleteWatchdogBudget(endpoint, pending);
});

it("starts the complete watchdog budget after slow request encoding", async () => {
  vi.useFakeTimers();
  const { endpoint, client } = watchdogFixture();
  const copySamples = sampleCopy.copySampleRange;
  const encoding = vi
    .spyOn(sampleCopy, "copySampleRange")
    .mockImplementation((source, target, start, end, proof) => {
      vi.advanceTimersByTime(500);
      copySamples(source, target, start, end, proof);
    });
  try {
    const pending = client
      .execute({
        identity,
        snapshot: createOneStrokeWorkerSnapshot(),
        baseModelRevision: null,
        modelRevision: 0,
        type: "model-sync-full",
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(encoding).toHaveBeenCalledOnce();
    expect(endpoint.sentMessages).toContainEqual(
      expect.objectContaining({ requestId: 1, type: "inkbook-worker-request" }),
    );
    expect(vi.getTimerCount()).toBe(1);
    await expectCompleteWatchdogBudget(endpoint, pending);
  } finally {
    encoding.mockRestore();
    client.terminate();
  }
});

it("reports a hosted execution failure with its request phase exactly once", async () => {
  const harness = createWorkerBridgeHarness();
  vi.spyOn(harness.runtime, "execute").mockRejectedValueOnce(new Error("runtime failure"));
  const failure = vi.fn();
  const client = new WorkerDocumentRuntimePort(() => harness.clientEndpoint, {
    workScheduler: new TestWorkScheduler(),
    frameIntervalMilliseconds: () => 1000 / 60,
    onExecutorFailure: failure,
  });
  try {
    await expect(client.execute(verification)).rejects.toThrow("executor-failed");
    expect(failure).toHaveBeenCalledWith({
      kind: "error",
      phase: "host-execution",
      request: verification,
    });
    expect(harness.clientEndpoint.terminated).toBe(true);
    expect(failure).toHaveBeenCalledOnce();
  } finally {
    client.terminate();
    harness.detach();
  }
});

it.each(["SyntaxError", "private document content", undefined])(
  "reports only allowlisted native exception names for %s",
  async (name) => {
    const endpoint = new TestWorkerEndpoint();
    const subscribe = vi.spyOn(endpoint, "addEventListener");
    const failure = vi.fn();
    const client = new WorkerDocumentRuntimePort(() => endpoint, {
      workScheduler: new TestWorkScheduler(),
      frameIntervalMilliseconds: () => 1000 / 60,
      onExecutorFailure: failure,
    });
    const pending = client.execute(verification).catch((error: unknown) => error);
    const handler = subscribe.mock.calls.find(([type]) => type === "error")![1] as (
      event: unknown,
    ) => void;
    handler({ error: { name, message: "document content" }, filename: "private file path" });
    expect(await pending).toEqual(new Error("Document worker failed."));
    expect(failure).toHaveBeenCalledWith({
      kind: "error",
      phase: "worker-event",
      ...(name === "SyntaxError" ? { errorName: name } : {}),
    });
    expect(failure).toHaveBeenCalledOnce();
    expect(endpoint.terminated).toBe(true);
  },
);

it("keeps a hung unlock observer subject to the bounded watchdog", async () => {
  vi.useFakeTimers();
  const { endpoint, client } = watchdogFixture();
  const sender = new TestWorkerEndpoint();
  sender.peer = endpoint;
  const request = createWorkerUnlockRequest(new Uint8Array());
  const observer = { unlockBatch: vi.fn(() => new Promise<void>(() => undefined)) };
  const pending = client.execute(request, observer).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  const batch = encodeUnlockBatch({
    identity: request.identity,
    batchIndex: 0,
    elements: [],
    derivations: [],
  });
  sender.postMessage({ batch: batch.value, requestId: 1, type: "inkbook-worker-unlock-batch" });
  await vi.advanceTimersByTimeAsync(100);
  expect(observer.unlockBatch).toHaveBeenCalledOnce();
  expect(await pending).toEqual(new Error("Document worker request timed out."));
  expect(endpoint.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps required scene geometry subject to the watchdog during navigation", async () => {
  vi.useFakeTimers();
  const { endpoint, client } = watchdogFixture();
  client.setNavigationActive(true);
  const pending = client
    .execute({ identity, basisRevision: 0, ids: [], type: "prepare-scene-paths" })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toEqual(new Error("Document worker request timed out."));
  expect(endpoint.terminated).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
