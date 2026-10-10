import { describe, expect, it, vi } from "vitest";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
  type DocumentRuntimeRequest,
} from "../../../../src/persistence/worker/runtime/public";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { rectangle, snapshot } from "../../../unit/persistence/worker/runtime/fixtures";
import { AutosaveDocumentFixture, FakeClock, MemoryVault, serializeSnapshot } from "./fixtures";

async function harness(failure: "export" | "active-write" | "sync" | "external") {
  const initial = serializeSnapshot();
  const document = new AutosaveDocumentFixture();
  const vault = new MemoryVault(initial.svg);
  const core = new DocumentWorkerRuntime({ sessionId: "restart", workerEpoch: 1 });
  await core.execute({
    type: "unlock",
    input: initial.svg,
    identity: { sessionId: "restart", workerEpoch: 1, operationId: 1, purpose: "unlock" },
  });
  const replacementRequests: DocumentRuntimeRequest[] = [];
  const replacementCore = new DocumentWorkerRuntime({ sessionId: "restart", workerEpoch: 2 });
  const replacement = {
    execute: (request: DocumentRuntimeRequest) => {
      replacementRequests.push(request);
      return replacementCore.execute(request);
    },
    terminate: vi.fn(() => replacementCore.terminate()),
  };
  let release!: (executor: DocumentRuntimePort) => void;
  let started!: () => void;
  const restarting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const createReplacement = vi.fn(() => {
    started();
    return new Promise<DocumentRuntimePort>((resolve) => {
      release = resolve;
    });
  });
  const primary = {
    execute: vi.fn<DocumentRuntimePort["execute"]>((request, observer) => {
      if (failure === "export" && request.type === "export-incremental")
        return Promise.reject(new Error("worker crashed"));
      if (failure === "sync" && request.type === "model-sync-incremental")
        return Promise.reject(new Error("worker crashed during synchronization"));
      return core.execute(request, observer);
    }),
    terminate: vi.fn(() => core.terminate()),
  };
  const clock = new FakeClock();
  const coordinator = new AutosaveCoordinator({
    workScheduler: createTestWorkScheduler(),
    clock,
    documentSource: document,
    confirmedBase: { type: "confirmed", revision: 0, outputHash: initial.hash },
    executor: primary,
    createReplacement,
    initialSnapshot: snapshot(),
    path: "restart.svg",
    sessionId: "restart",
    vault,
    workerEpoch: 1,
  });
  function commit(revision: number) {
    document.commit(revision, 100 + revision * 20);
    coordinator.recordCommit({
      modelRevision: revision,
      changedElements: [rectangle(100 + revision * 20)],
    });
  }
  return {
    coordinator,
    clock,
    commit,
    vault,
    primary,
    replacement,
    replacementRequests,
    createReplacement,
    restarting,
    release: () => release(replacement),
  };
}

describe("autosave external worker restart", () => {
  it("allows host recovery to defer persistence after bootstrap", async () => {
    const fixture = await harness("external");
    try {
      fixture.commit(1);
      const recovery = fixture.coordinator.recoverWorkerExecutor(false);
      await fixture.restarting;
      fixture.clock.advance(1_000);
      fixture.release();
      expect(await recovery).toBe(true);
      expect(fixture.replacementRequests).toEqual([]);
      expect(fixture.vault.processCount).toBe(0);
      expect(fixture.coordinator.dirty).toBe(true);
    } finally {
      fixture.coordinator.dispose();
    }
  });

  it.each(["timer", "flush"] as const)(
    "resumes an external restart after %s requested a save during bootstrap",
    async (trigger) => {
      const fixture = await harness("external");
      try {
        fixture.commit(1);
        const recovery = fixture.coordinator.recoverWorkerExecutor();
        await fixture.restarting;
        fixture.commit(2);
        const flush = trigger === "flush" ? fixture.coordinator.flush("lock") : undefined;
        if (trigger === "timer") fixture.clock.advance(1_000);
        expect(fixture.replacementRequests).toEqual([]);
        expect(fixture.vault.processCount).toBe(0);
        fixture.release();
        expect(await recovery).toBe(true);
        expect(fixture.replacementRequests).toEqual([
          expect.objectContaining({ type: "export-full", workerEpoch: 2, modelRevision: 2 }),
        ]);
        if (flush !== undefined) expect(await flush).toBe("clean");
        else {
          await fixture.vault.waitForProcessCount(1);
          await fixture.coordinator.currentSaveSettlement;
        }
        expect(fixture.vault.processCount).toBe(1);
        expect(fixture.coordinator.dirty).toBe(false);
      } finally {
        fixture.coordinator.dispose();
      }
      expect(fixture.createReplacement).toHaveBeenCalledOnce();
      expect(fixture.replacement.terminate).toHaveBeenCalledOnce();
    },
  );

  it("preserves an unexpired debounce after external restart", async () => {
    const fixture = await harness("external");
    try {
      fixture.commit(1);
      const recovery = fixture.coordinator.recoverWorkerExecutor();
      await fixture.restarting;
      fixture.clock.advance(999);
      fixture.release();
      expect(await recovery).toBe(true);
      expect(fixture.replacementRequests).toEqual([]);
      fixture.clock.advance(1);
      expect(fixture.replacementRequests).toEqual([
        expect.objectContaining({ type: "export-full", workerEpoch: 2, modelRevision: 1 }),
      ]);
      await fixture.vault.waitForProcessCount(1);
      await fixture.coordinator.currentSaveSettlement;
      expect(fixture.vault.processCount).toBe(1);
      expect(fixture.coordinator.dirty).toBe(false);
    } finally {
      fixture.coordinator.dispose();
    }
  });
});

describe("autosave native worker restart", () => {
  it("exports the latest dirty revision once after pending bootstrap without losing flush waiters", async () => {
    const fixture = await harness("export");
    try {
      fixture.commit(1);
      const flush = fixture.coordinator.flush("lock");
      await fixture.restarting;
      expect(fixture.primary.terminate).toHaveBeenCalledOnce();
      fixture.commit(2);
      const successorFlush = fixture.coordinator.flush("detach");
      expect(fixture.replacementRequests).toEqual([]);
      expect(fixture.vault.processCount).toBe(0);
      fixture.release();
      expect(await Promise.all([flush, successorFlush])).toEqual(["clean", "clean"]);
      expect(fixture.createReplacement).toHaveBeenCalledOnce();
      expect(fixture.replacementRequests.filter(({ type }) => type.startsWith("export-"))).toEqual([
        expect.objectContaining({
          type: "export-full",
          workerEpoch: 2,
          modelRevision: 2,
          snapshot: { ...snapshot(), revision: 2, elements: [rectangle(140)] },
        }),
      ]);
      expect(fixture.vault.processCount).toBe(1);
      expect(fixture.coordinator.dirty).toBe(false);
    } finally {
      fixture.coordinator.dispose();
    }
    expect(fixture.replacement.terminate).toHaveBeenCalledOnce();
  });

  it("finishes verification of an active write without repeating the write after restart", async () => {
    const fixture = await harness("active-write");
    try {
      let releaseWrite!: () => void;
      fixture.vault.processGate = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      fixture.commit(1);
      const flush = fixture.coordinator.flush("lock");
      await fixture.vault.waitForProcessCount(1);
      const recovery = fixture.coordinator.recoverWorkerExecutor();
      await fixture.restarting;
      expect(fixture.vault.processCount).toBe(1);
      fixture.release();
      expect(await recovery).toBe(true);
      releaseWrite();
      expect(await flush).toBe("clean");
      expect(fixture.vault.processCount).toBe(1);
      expect(fixture.replacementRequests).toEqual([]);
      expect(fixture.coordinator.dirty).toBe(false);
    } finally {
      fixture.coordinator.dispose();
    }
  });
});

it("resumes a flush that waited for model synchronization when that worker crashes", async () => {
  const fixture = await harness("sync");
  try {
    fixture.commit(1);
    const synchronization = fixture.coordinator.synchronizeWorkerBaseline({
      sessionId: "restart",
      workerEpoch: 1,
      operationId: 1,
      purpose: "clipboard",
    });
    const flush = fixture.coordinator.flush("lock");
    await fixture.restarting;
    fixture.release();
    expect(await synchronization).toBe(false);
    expect(await flush).toBe("clean");
    expect(
      fixture.replacementRequests.filter(({ type }) => type.startsWith("export-")),
    ).toHaveLength(1);
    expect(fixture.replacementRequests[0]?.type).toBe("export-full");
    expect(fixture.vault.processCount).toBe(1);
  } finally {
    fixture.coordinator.dispose();
  }
});
