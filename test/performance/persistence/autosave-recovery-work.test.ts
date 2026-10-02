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
