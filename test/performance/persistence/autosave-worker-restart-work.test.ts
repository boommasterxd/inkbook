import { expect, it, vi } from "vitest";
import { AutosaveCoordinator } from "../../../src/persistence/saving/autosave/public";
import { createVaultExecutorReplacement } from "../../../src/obsidian/embeds/vault-executor-replacement";
import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
} from "../../../src/persistence/worker/runtime/public";
import { createTestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import { createTestDocumentRuntimes } from "../../integration/obsidian/embeds/vault-session-fixtures";
import { createStandardPersistenceFixture } from "./fixtures";
import type {
  AutosaveCoordinatorOptions,
  AutosaveDocumentSource,
} from "../../../src/persistence/saving/autosave/types";

function createCoordinator(
  options: Pick<
    AutosaveCoordinatorOptions,
    "initialSnapshot" | "executor" | "clock" | "createReplacement"
  > & {
    readonly documentSource: Pick<AutosaveDocumentSource, "currentRevision" | "snapshot">;
  },
) {
  const process = vi.fn();
  const coordinator = new AutosaveCoordinator({
    ...options,
    workScheduler: createTestWorkScheduler(),
    confirmedBase: { type: "confirmed", revision: 0, outputHash: "a".repeat(64) },
    documentSource: {
      ...options.documentSource,
      isGestureActive: () => false,
      orderByBand: () => ({}),
    },
    path: "bounded.svg",
    sessionId: "bounded",
    workerEpoch: 1,
    vault: { process, readWithMetadataGuard: vi.fn() },
  });
  return { coordinator, process };
}

it("bounds full Store reads and live executors across native restart and failed fallback", async () => {
  const initial = createStandardPersistenceFixture(0);
  const requests: DocumentRuntimeRequest[] = [];
  const executors: DocumentRuntimePort[] = [];
  let active = 0;
  let peak = 0;
  let disposed = false;
  let fallbackUsed = false;
  let revision = 0;
  function failingExecutor(): DocumentRuntimePort {
    active += 1;
    peak = Math.max(peak, active);
    let terminated = false;
    const port = {
      execute: (request: DocumentRuntimeRequest) => {
        requests.push(request);
        return Promise.reject(new Error("executor crashed"));
      },
      terminate: vi.fn(() => {
        if (!terminated) active -= 1;
        terminated = true;
      }),
    };
    executors.push(port);
    return port;
  }
  const createNative = vi.fn(async () => {
    expect(active).toBe(0);
    return failingExecutor();
  });
  const fallback = vi.fn(() => {
    expect(active).toBe(0);
    fallbackUsed = true;
    return failingExecutor();
  });
  const createReplacement = createVaultExecutorReplacement({
    identity: { documentId: "bounded.svg", sessionId: "bounded" },
    adopt: vi.fn(),
    disposed: () => disposed,
    fallback,
    fallbackUsed: () => fallbackUsed,
    priority: { gestureActive: false, navigationActive: false },
    runtimes: createTestDocumentRuntimes({
      create: createNative,
      createFallback: fallback,
      createStoreScheduler: () => ({
        isCancelled: () => false,
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    }),
  });
  const snapshot = vi.fn(() => ({ ...initial, revision: 1 }));
  const { coordinator, process } = createCoordinator({
    initialSnapshot: initial,
    executor: failingExecutor(),
    createReplacement,
    documentSource: {
      currentRevision: () => revision,
      snapshot,
    },
    clock: { clearTimeout: vi.fn(), setTimeout: vi.fn() },
  });
  try {
    revision = 1;
    coordinator.recordCommit({ modelRevision: 1 });
    expect(await coordinator.flush("lock")).toBe("executor-failed");
    expect(createNative).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(requests.map(({ type }) => type)).toEqual([
      "export-incremental",
      "export-full",
      "export-full",
    ]);
    for (const request of requests.slice(1)) {
      expect(request.type).toBe("export-full");
      if (request.type === "export-full") expect(request.snapshot.elements).toHaveLength(11_000);
    }
    expect(process).not.toHaveBeenCalled();
    expect(coordinator.dirty).toBe(true);
  } finally {
    disposed = true;
    coordinator.dispose();
  }
  expect(active).toBe(0);
  expect(executors).toHaveLength(3);
});

it("reads one complete standard Store for the single allowed same-call baseline repair", async () => {
  const initial = createStandardPersistenceFixture(0);
  let revision = 0;
  const requests: DocumentRuntimeRequest[] = [];
  const snapshot = vi.fn(() => ({ ...initial, revision }));
  const executor: DocumentRuntimePort = {
    execute: async (request) => {
      requests.push(request);
      if (request.type === "model-sync-incremental")
        return {
          type: "runtime-failure",
          identity: request.identity,
          code: "base-revision-mismatch",
          retryable: true,
        };
      if (request.type === "model-sync-full")
        return {
          type: "model-sync-success",
          identity: request.identity,
          modelRevision: request.modelRevision,
        };
      throw new Error("Unexpected export or verification");
    },
    terminate: vi.fn(),
  };
  const { coordinator, process } = createCoordinator({
    initialSnapshot: initial,
    executor,
    documentSource: {
      currentRevision: () => revision,
      snapshot,
    },
    clock: { clearTimeout: vi.fn(), setTimeout: () => 1 },
  });
  try {
    revision = 1;
    coordinator.recordCommit({ modelRevision: revision });
    expect(
      await coordinator.synchronizeWorkerBaseline({
        sessionId: "bounded",
        workerEpoch: 1,
        operationId: 1,
        purpose: "clipboard",
      }),
    ).toBe(true);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(requests.map(({ type }) => type)).toEqual(["model-sync-incremental", "model-sync-full"]);
    const full = requests[1];
    expect(full?.type).toBe("model-sync-full");
    if (full?.type === "model-sync-full") expect(full.snapshot.elements).toHaveLength(11_000);
    expect(process).not.toHaveBeenCalled();
    expect(coordinator.dirty).toBe(true);
  } finally {
    coordinator.dispose();
  }
});
