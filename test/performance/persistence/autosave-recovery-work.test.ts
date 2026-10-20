import { createTestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import { describe, expect, it, vi } from "vitest";
import { AutosaveCoordinator } from "../../../src/persistence/saving/autosave/public";
import type { AutosaveStatus } from "../../../src/persistence/saving/autosave/types";
import type { ExistingFilePort } from "../../../src/persistence/saving/save-ports";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
  type DocumentRuntimeRequest,
} from "../../../src/persistence/worker/runtime/public";
import { createMinimalPersistenceFixture } from "./fixtures";
import { AutosaveWorkerModelState } from "../../../src/persistence/saving/autosave/worker-model-state";
import { FILE_SCHEMA_LIMITS } from "../../../src/domain/schema/public";
import { CoalescedExportTarget } from "../../../src/persistence/worker/coalesced-export";
import { createTestStroke } from "../../fixtures/persistence/worker-snapshot";

it("bounds coalesced history by document capacity and captures the latest full snapshot lazily", () => {
  const state = new AutosaveWorkerModelState(0);
  const stroke = createTestStroke();
  const snapshot = vi.fn(() => createMinimalPersistenceFixture(revision));
  const orderByBand = vi.fn(() => ({}));
  const document = {
    snapshot,
    orderByBand,
    currentRevision: () => revision,
    isGestureActive: () => false,
  };
  const target = new CoalescedExportTarget<{ id: string }, never>(0, ({ id }) => id);
  let revision = 0;
  for (let index = 0; index < FILE_SCHEMA_LIMITS.elements; index += 1) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    target.record({ modelRevision: ++revision, removedIds: [id] });
  }
  const bounded = target.materialize({});
  expect(bounded.type).toBe("incremental");
  if (bounded.type !== "incremental") throw new Error("Missing bounded incremental plan.");
  expect(bounded.removedIds).toHaveLength(FILE_SCHEMA_LIMITS.elements);
  expect(bounded.changedElements).toHaveLength(0);
  state.record({ modelRevision: revision, removedIds: bounded.removedIds });

  for (let index = FILE_SCHEMA_LIMITS.elements; index < FILE_SCHEMA_LIMITS.elements * 3; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    state.record({ modelRevision: ++revision, changedElements: [{ ...stroke, id }] });
    state.record({ modelRevision: ++revision, removedIds: [id] });
  }
  expect(state.requiresFullSynchronization).toBe(true);
  expect(snapshot).not.toHaveBeenCalled();
  expect(state.takePlan(document)).toEqual({
    baseModelRevision: null,
    modelRevision: revision,
    snapshot: createMinimalPersistenceFixture(revision),
    type: "full",
  });
  expect(snapshot).toHaveBeenCalledOnce();
  expect(orderByBand).not.toHaveBeenCalled();
  expect(state.takePlan(document)).toBeNull();
  state.acknowledgeExport(revision);
  state.record({ modelRevision: ++revision, changedElements: [stroke] });
  expect(state.takePlan(document)).toMatchObject({
    baseModelRevision: revision - 1,
    modelRevision: revision,
    type: "incremental",
    changedElements: [stroke],
  });
});

interface RecoveryOptions {
  readonly failFull?: boolean;
  readonly successor?: boolean;
}

function createRecovery(options: RecoveryOptions = {}) {
  let revision = 0;
  let timer: (() => void) | null = null;
  const initial = createMinimalPersistenceFixture();
  const serialized = serializeInkbookDocument(initial);
  if (!serialized.ok) throw new Error("Expected initial document");
  let content = serialized.value.svg;
  let resolveTerminal!: (status: AutosaveStatus) => void;
  const terminal = new Promise<AutosaveStatus>((resolve) => {
    resolveTerminal = resolve;
  });
  const runtime = new DocumentWorkerRuntime({ sessionId: "recovery", workerEpoch: 1 });
  const requests: DocumentRuntimeRequest[] = [];
  const executor: DocumentRuntimePort = {
    execute: async (request) => {
      requests.push(request);
      if (
        request.type === "export-incremental" ||
        (request.type === "export-full" && options.failFull)
      ) {
        if (options.successor && request.type === "export-incremental") commit();
        return {
          ...request,
          type: "export-failure",
          error: { code: "snapshot-invalid", retryable: false },
        };
      }
      return runtime.execute(request);
    },
    terminate: () => runtime.terminate(),
  };
  const process = vi.fn<ExistingFilePort["process"]>(async (_path, update) => {
    content = update(content);
    return content;
  });
  const vault: ExistingFilePort = {
    process,
    readWithMetadataGuard: async (path) => ({
      content,
      identity: { path, ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
      materialization: "host-full-read-not-bounded",
      stabilityEvidence: "object-identity-and-stat-unchanged",
    }),
  };
  const coordinator = new AutosaveCoordinator({
    workScheduler: createTestWorkScheduler(),
    initialSnapshot: initial,
    sessionId: "recovery",
    workerEpoch: 1,
    path: "recovery.svg",
    confirmedBase: { type: "confirmed", revision: 0, outputHash: serialized.value.hash },
    executor,
    vault,
    clock: {
      setTimeout: (callback) => {
        timer = callback;
        return 1;
      },
      clearTimeout: () => {
        timer = null;
      },
    },
    documentSource: {
      currentRevision: () => revision,
      isGestureActive: () => false,
      orderByBand: () => ({}),
      snapshot: () => createMinimalPersistenceFixture(revision),
    },
    observer: {
      statusChanged: (status) => {
        if (status === "clean" || status === "retryable-error") resolveTerminal(status);
      },
    },
  });
  function commit() {
    revision += 1;
    coordinator.recordCommit({ modelRevision: revision });
  }
  return {
    coordinator,
    process,
    requests,
    terminal,
    vault,
    commit,
    dispatch: () => {
      const callback = timer;
      timer = null;
      callback?.();
    },
  };
}

describe("bounded autosave export recovery", () => {
  it.each([false, true])(
    "saves automatically after an incremental failure with successor=%s",
    async (successor) => {
      const fixture = createRecovery({ successor });
      try {
        fixture.commit();
        fixture.dispatch();
        expect(await fixture.terminal).toBe("clean");
        const exports = fixture.requests.filter((request) => request.type.startsWith("export-"));
        expect(exports.map(({ type }) => type)).toEqual(["export-incremental", "export-full"]);
        expect(exports[1]).toMatchObject({
          modelRevision: successor ? 2 : 1,
          baseModelRevision: null,
        });
        expect(fixture.process).toHaveBeenCalledOnce();
        expect(fixture.coordinator.dirty).toBe(false);
      } finally {
        fixture.coordinator.dispose();
      }
    },
  );

  it.each([false, true])(
    "stops after one failed full recovery with successor=%s",
    async (successor) => {
      const fixture = createRecovery({ failFull: true, successor });
      try {
        fixture.commit();
        fixture.dispatch();
        expect(await fixture.terminal).toBe("retryable-error");
        fixture.dispatch();
        await Promise.resolve();
        expect(fixture.requests.map(({ type }) => type)).toEqual([
          "export-incremental",
          "export-full",
        ]);
        expect(fixture.process).not.toHaveBeenCalled();
        expect(fixture.coordinator.dirty).toBe(true);
      } finally {
        fixture.coordinator.dispose();
      }
    },
  );

  it("does not dispatch recovery after terminal disposal", async () => {
    const fixture = createRecovery();
    fixture.commit();
    fixture.dispatch();
    fixture.coordinator.dispose();
    await Promise.resolve();
    expect(fixture.requests.map(({ type }) => type)).toEqual(["export-incremental"]);
    expect(fixture.process).not.toHaveBeenCalled();
  });
});
