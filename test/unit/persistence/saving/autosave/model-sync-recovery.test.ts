import { expect, it, vi } from "vitest";
import { executeAutosaveModelSynchronization } from "../../../../../src/persistence/saving/autosave/model-sync-recovery";
import { matchesModelSyncResult } from "../../../../../src/persistence/saving/autosave/export-request";
import type {
  ModelSyncRuntimeRequest,
  DocumentRuntimeResult,
} from "../../../../../src/persistence/worker/runtime/public";
import { snapshot } from "../../worker/runtime/fixtures";

const identity = {
  sessionId: "sync",
  workerEpoch: 1,
  operationId: 1,
  purpose: "clipboard" as const,
};
const request: ModelSyncRuntimeRequest = {
  type: "model-sync-incremental",
  identity,
  modelRevision: 1,
  baseModelRevision: 0,
};
const mismatch: DocumentRuntimeResult = {
  type: "runtime-failure",
  identity,
  code: "base-revision-mismatch",
  retryable: true,
};

it("retries an exact incremental mismatch once from the current complete Store", async () => {
  const execute = vi.fn(
    async (candidate: ModelSyncRuntimeRequest): Promise<DocumentRuntimeResult> =>
      candidate.type === "model-sync-incremental"
        ? mismatch
        : { type: "model-sync-success", identity, modelRevision: 1 },
  );
  const complete = { ...snapshot(), revision: 1 };
  const readSnapshot = vi.fn(() => complete);
  expect(
    await executeAutosaveModelSynchronization({
      request,
      execute,
      current: () => true,
      snapshot: readSnapshot,
    }),
  ).toMatchObject({ type: "model-sync-success" });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]?.[0]).toEqual({
    type: "model-sync-full",
    identity,
    modelRevision: 1,
    baseModelRevision: null,
    snapshot: complete,
  });
  expect(readSnapshot).toHaveBeenCalledOnce();
});

it.each([
  { name: "queue full", result: { ...mismatch, code: "queue-full" } },
  { name: "nonretryable mismatch", result: { ...mismatch, retryable: false } },
  { name: "invalid model", result: { ...mismatch, code: "snapshot-invalid" } },
  { name: "stale identity", result: { ...mismatch, identity: { ...identity, operationId: 2 } } },
  { name: "success", result: { type: "model-sync-success" as const, identity, modelRevision: 1 } },
])("does not retry $name", async ({ result }) => {
  const execute = vi.fn(async () => result);
  const readSnapshot = vi.fn(() => snapshot());
  expect(
    await executeAutosaveModelSynchronization({
      request,
      execute,
      current: () => true,
      snapshot: readSnapshot,
    }),
  ).toBe(result);
  expect(execute).toHaveBeenCalledOnce();
  expect(readSnapshot).not.toHaveBeenCalled();
});

it.each(["before-snapshot", "during-snapshot", "snapshot-revision"] as const)(
  "rejects changed ownership %s",
  async (phase) => {
    let current = phase !== "before-snapshot";
    const execute = vi.fn(async () => mismatch);
    const readSnapshot = vi.fn(() => {
      if (phase === "during-snapshot") current = false;
      return { ...snapshot(), revision: phase === "snapshot-revision" ? 2 : 1 };
    });
    expect(
      await executeAutosaveModelSynchronization({
        request,
        execute,
        current: () => current,
        snapshot: readSnapshot,
      }),
    ).toBe(mismatch);
    expect(execute).toHaveBeenCalledOnce();
  },
);

it("stops after a failed full resync and propagates genuine executor failures", async () => {
  const execute = vi.fn(async () => mismatch);
  const options = {
    request,
    execute,
    current: () => true,
    snapshot: () => ({ ...snapshot(), revision: 1 }),
  };
  expect(await executeAutosaveModelSynchronization(options)).toBe(mismatch);
  expect(execute).toHaveBeenCalledTimes(2);
  execute.mockClear();
  const full: ModelSyncRuntimeRequest = {
    type: "model-sync-full",
    identity,
    modelRevision: 1,
    baseModelRevision: null,
    snapshot: options.snapshot(),
  };
  expect(await executeAutosaveModelSynchronization({ ...options, request: full })).toBe(mismatch);
  expect(execute).toHaveBeenCalledOnce();
  await expect(
    executeAutosaveModelSynchronization({
      ...options,
      execute: async () => {
        throw new Error("worker crashed");
      },
    }),
  ).rejects.toThrow("worker crashed");
});

it("does not acknowledge a late model synchronization after executor replacement", () => {
  const result: DocumentRuntimeResult = { type: "model-sync-success", identity, modelRevision: 1 };
  expect(matchesModelSyncResult(request, result)).toBe(true);
  expect(matchesModelSyncResult(request, result, 2)).toBe(false);
});
