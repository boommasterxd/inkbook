import { afterEach, expect, it, vi } from "vitest";

import { RequestWatchdog } from "../../../src/persistence/worker/runtime/request-timeout";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/document-runtime";
import { WorkerDocumentRuntimePort } from "../../../src/persistence/worker/runtime/worker-bridge";
import { TestWorkerEndpoint } from "../../fixtures/persistence/worker-endpoint";
import { TestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

afterEach(() => vi.useRealTimers());

it("releases every internally cancelled speculative request without killing the worker or retaining timers", async () => {
  vi.useFakeTimers();
  const endpoint = new TestWorkerEndpoint();
  const failure = vi.fn();
  const client = new WorkerDocumentRuntimePort(() => endpoint, {
    workScheduler: new TestWorkScheduler({
      budgetMs: INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
    }),
    frameIntervalMilliseconds: () => INTERACTION_REFRESH_PROFILE.frameDurationMs,
    onExecutorFailure: failure,
  });
  try {
    for (let operationId = 1; operationId <= 10_000; operationId += 1) {
      const identity = {
        sessionId: "session-a",
        workerEpoch: 1,
        operationId,
        purpose: "background" as const,
      };
      const pending = client.execute({
        identity,
        basisRevision: 0,
        ids: ["stroke"],
        speculative: true,
        type: "prepare-scene-paths",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      client.setNavigationActive(true);
      await expect(pending).resolves.toMatchObject({
        identity,
        code: "scene-preparation-cancelled",
        type: "runtime-failure",
      });
      expect(vi.getTimerCount()).toBe(0);
      client.setNavigationActive(false);
    }
    expect(failure).not.toHaveBeenCalled();
    expect(endpoint.terminated).toBe(false);
    expect(
      endpoint.sentMessages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "action" in message &&
          message.action === "cancel-scene-paths",
      ),
    ).toHaveLength(10_000);
  } finally {
    client.terminate();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("retains at most one watchdog timer through 10,000 navigation pauses and releases cancellation", () => {
  vi.useFakeTimers();
  const expired = vi.fn();
  const watchdog = new RequestWatchdog(expired, 30_000, () => Date.now());
  for (let index = 0; index < 10_000; index += 1) {
    watchdog.setGatePaused(true);
    expect(vi.getTimerCount()).toBe(0);
    watchdog.setGatePaused(false);
    expect(vi.getTimerCount()).toBe(1);
  }
  watchdog.cancel();
  expect(vi.getTimerCount()).toBe(0);
  vi.runAllTimers();
  expect(expired).not.toHaveBeenCalled();
});

it("bounds queued required requests to four without allocating geometry for 10,000 rejected arrivals", async () => {
  const runtime = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
  runtime.setNavigationActive(true);
  const queued: Promise<unknown>[] = [];
  for (let operationId = 1; operationId <= 4; operationId += 1) {
    queued.push(
      runtime.execute({
        identity: { sessionId: "session-a", workerEpoch: 1, operationId, purpose: "verification" },
        input: "not-svg",
        type: "verify-output",
      }),
    );
  }
  for (let operationId = 5; operationId < 10_005; operationId += 1) {
    await expect(
      runtime.execute({
        identity: { sessionId: "session-a", workerEpoch: 1, operationId, purpose: "verification" },
        input: "not-svg",
        type: "verify-output",
      }),
    ).resolves.toMatchObject({ code: "queue-full", retryable: true, type: "runtime-failure" });
    expect(runtime.instrumentation.retainedJobs).toBe(4);
    expect(runtime.instrumentation.queuedJobs).toBe(4);
  }
  expect(runtime.instrumentation.fragmentBuilds).toBe(0);
  expect(runtime.instrumentation.shapeBuilds).toBe(0);
  runtime.setNavigationActive(false);
  await expect(Promise.all(queued)).resolves.toHaveLength(4);
  expect(runtime.instrumentation.retainedJobs).toBe(0);
  expect(runtime.instrumentation.queuedJobs).toBe(0);
  await expect(
    runtime.execute({
      identity: {
        sessionId: "session-a",
        workerEpoch: 1,
        operationId: 10_006,
        purpose: "verification",
      },
      input: "not-svg",
      type: "verify-output",
    }),
  ).resolves.toMatchObject({ type: "verify-output-success" });
  runtime.terminate();
  expect(runtime.instrumentation.cacheElements).toBe(0);
});
