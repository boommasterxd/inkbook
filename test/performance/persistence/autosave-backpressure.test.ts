import { describe, expect, it, vi } from "vitest";

import { InteractiveWorkPriority } from "../../../src/editor/session/interactive-work-priority";
import { AutosaveCoordinator } from "../../../src/persistence/saving/autosave/public";
import { type AutosaveClock } from "../../../src/persistence/saving/autosave/public";
import { type AutosaveDocumentSource } from "../../../src/persistence/saving/autosave/types";
import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
} from "../../../src/persistence/worker/runtime/public";
import type {
  ExistingFilePort,
  MetadataGuardedFileRead,
} from "../../../src/persistence/saving/save-ports";
import {
  deriveDocumentIntegrityManifest,
  serializeInkbookDocument,
} from "../../../src/persistence/serialization/public";
import { yieldToMainThread } from "../../../src/persistence/scheduling/main-thread-yield";
import type { ExportSuccess } from "../../../src/persistence/worker/protocol";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import { createMinimalPersistenceFixture } from "./fixtures";

describe("autosave backpressure", () => {
  it("rejects a stale receipt while retaining its worker-model baseline", async () => {
    const clock = new ManualClock();
    const document = new MutableDocument();
    const executor = new ControlledExecutor();
    const coordinator = createCoordinator(
      clock,
      document,
      executor,
      new ControlledVault(output(0)),
    );
    document.commit();
    coordinator.recordCommit({ modelRevision: 1 });
    clock.advance(500);
    await settleUntil(() => executor.exportRequests.length === 1, "initial export dispatch");
    document.commit();
    coordinator.recordCommit({ modelRevision: 2 });
    executor.completeExport(0);
    await settleUntil(() => executor.acknowledgements.length === 1, "stale export acknowledgement");

    expect(executor.acknowledgements).toEqual([{ accepted: false, modelRevision: 1 }]);
    clock.advance(500);
    await settleUntil(() => executor.exportRequests.length === 2, "successor export dispatch");
    expect(executor.exportRequests[1]).toMatchObject({
      baseModelRevision: 1,
      modelRevision: 2,
      type: "export-incremental",
    });
    coordinator.dispose();
  });
});

describe("autosave successor scheduling", () => {
  it.each([0, 500])(
    "drains a paused stale export while respecting a successor debounce elapsed by %s ms",
    async (elapsed) => {
      const { clock, document, executor, vault } = createControlledSave();
      const priority = new InteractiveWorkPriority();
      const { entered, wait } = observePriority(priority);
      const coordinator = createCoordinator(clock, document, executor, vault, wait);
      document.commit();
      coordinator.recordCommit({ modelRevision: 1 });
      clock.advance(500);
      const release = priority.begin();
      executor.completeExport(0);
      await entered;
      document.commit();
      coordinator.recordCommit({ modelRevision: 2 });
      clock.advance(elapsed);
      expect(executor.exportRequests).toHaveLength(1);
      expect(vault.processCalls).toBe(0);
      release();
      await settleUntil(
        () => executor.acknowledgements.length === 1,
        "paused stale acknowledgement",
      );
      expect(executor.acknowledgements).toEqual([{ accepted: false, modelRevision: 1 }]);
      if (elapsed === 0) {
        expect(executor.exportRequests).toHaveLength(1);
        clock.advance(499);
        expect(executor.exportRequests).toHaveLength(1);
        clock.advance(1);
      }
      await settleUntil(() => executor.exportRequests.length === 2, "unforced successor dispatch");
      expect(executor.exportRequests[1]).toMatchObject({ modelRevision: 2, baseModelRevision: 1 });
      expect(executor.maximumActiveExports).toBe(1);
      executor.completeExport(1);
      await settleUntil(() => vault.processCalls === 1, "successor write");
      vault.completeWrite();
      await settleUntil(() => !coordinator.dirty, "saved successor");
      expect(vault.revision).toBe(2);
      expect(vault.processCalls).toBe(1);
      coordinator.dispose();
      priority.dispose();
    },
  );

  it.each([0, 500])(
    "drains a model-sync successor after %s ms without bypassing debounce",
    async (elapsed) => {
      const { clock, document, executor, vault } = createControlledSave();
      const coordinator = createCoordinator(clock, document, executor, vault);
      document.commit();
      coordinator.recordCommit({ modelRevision: 1 });
      const synchronization = deferred<DocumentRuntimeResult>();
      const execute = vi
        .spyOn(executor, "execute")
        .mockImplementationOnce(() => synchronization.promise);
      const identity = {
        sessionId: "performance",
        workerEpoch: 1,
        operationId: 1,
        purpose: "clipboard" as const,
      };
      const pending = coordinator.synchronizeWorkerBaseline(identity);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toMatchObject({
        type: "model-sync-incremental",
        modelRevision: 1,
      });
      document.commit();
      coordinator.recordCommit({ modelRevision: 2 });
      clock.advance(elapsed);
      expect(executor.exportRequests).toHaveLength(0);
      synchronization.resolve({ type: "model-sync-success", identity, modelRevision: 1 });
      await expect(pending).resolves.toBe(false);
      if (elapsed === 0) {
        expect(executor.exportRequests).toHaveLength(0);
        clock.advance(499);
        expect(executor.exportRequests).toHaveLength(0);
        clock.advance(1);
      }
      expect(executor.exportRequests).toHaveLength(1);
      expect(executor.exportRequests[0]).toMatchObject({ modelRevision: 2, baseModelRevision: 1 });
      expect(executor.maximumActiveExports).toBe(1);
      coordinator.dispose();
      execute.mockRestore();
    },
  );
});

describe("autosave write serialization", () => {
  it("serializes writes and drains one coalesced successor without another user action", async () => {
    await runBackpressureSequence();
  });
});

describe("autosave interactive priority work bounds", () => {
  it.each(["history", "drawing"])(
    "performs no hash, snapshot or vault work during %s",
    async (kind) => {
      const { clock, document, executor, vault } = createControlledSave();
      const priority = new InteractiveWorkPriority();
      priority.setInputActive(kind === "drawing");
      const release = kind === "history" ? priority.begin() : () => priority.setInputActive(false);
      const { entered, wait } = observePriority(priority);
      const coordinator = createCoordinator(clock, document, executor, vault, wait);
      document.commit();
      coordinator.recordCommit({ modelRevision: 1 });
      const flushed = coordinator.flush("retry");
      await settleUntil(() => executor.exportRequests.length === 1, "export dispatch");
      executor.completeExport(0);
      const snapshotRead = vi.spyOn(document, "snapshot");
      const hashUpdate = vi.spyOn(ChunkedSha256.prototype, "update");
      await entered;
      expect(snapshotRead).not.toHaveBeenCalled();
      expect(hashUpdate).not.toHaveBeenCalled();
      expect(vault.processCalls).toBe(0);
      release();
      await settleUntil(() => vault.processCalls === 1, "resumed vault write");
      expect(snapshotRead).toHaveBeenCalledTimes(1);
      expect(hashUpdate).toHaveBeenCalled();
      vault.completeWrite();
      await expect(flushed).resolves.toBe("clean");
      expect(vault.revision).toBe(1);
      expect(vault.processCalls).toBe(1);
      snapshotRead.mockRestore();
      hashUpdate.mockRestore();
      coordinator.dispose();
      priority.dispose();
    },
  );
});

function observePriority(priority: InteractiveWorkPriority) {
  const entered = deferred<void>();
  return {
    entered: entered.promise,
    wait: () => {
      entered.resolve();
      return priority.waitForBackground();
    },
  };
}

function createControlledSave() {
  return {
    clock: new ManualClock(),
    document: new MutableDocument(),
    executor: new ControlledExecutor(),
    vault: new ControlledVault(output(0)),
  };
}

async function runBackpressureSequence(): Promise<void> {
  const { clock, document, executor, vault } = createControlledSave();
  const coordinator = createCoordinator(clock, document, executor, vault);

  document.commit();
  coordinator.recordCommit({ modelRevision: 1 });
  clock.advance(500);
  await settleUntil(() => executor.exportRequests.length === 1, "initial export dispatch");
  expect(executor.exportRequests).toHaveLength(1);

  clock.advance(300);
  executor.completeExport(0);
  await settleUntil(() => vault.processCalls === 1, "initial vault write");
  expect(vault.processCalls).toBe(1);

  for (let revision = 2; revision <= 5; revision += 1) {
    document.commit();
    coordinator.recordCommit({ modelRevision: revision });
    clock.advance(50);
  }
  clock.advance(100);
  vault.completeWrite();
  await settleUntil(() => executor.exportRequests.length === 2, "coalesced successor export");
  expect(executor.exportRequests).toHaveLength(2);
  expect(executor.maximumActiveExports).toBe(1);

  clock.advance(300);
  executor.completeExport(1);
  await settleUntil(() => vault.processCalls === 2, "successor vault write");
  expect(vault.processCalls).toBe(2);
  expect(vault.maximumActiveWrites).toBe(1);

  clock.advance(300);
  vault.completeWrite();
  await settleUntil(() => !coordinator.dirty, "clean autosave state");
  expect(coordinator.dirty).toBe(false);
  expect(vault.revision).toBe(5);
  coordinator.dispose();
}

function createCoordinator(
  clock: ManualClock,
  document: MutableDocument,
  executor: ControlledExecutor,
  vault: ControlledVault,
  waitForBackground?: () => Promise<void>,
): AutosaveCoordinator {
  return new AutosaveCoordinator({
    clock,
    ...(waitForBackground ? { waitForBackground } : {}),
    confirmedBase: { outputHash: hash(0), revision: 0, type: "confirmed" },
    confirmedContent: output(0),
    documentSource: document,
    executor,
    initialSnapshot: document.snapshot(),
    path: "performance.svg",
    sessionId: "performance",
    vault,
    workerEpoch: 1,
  });
}

class MutableDocument implements AutosaveDocumentSource {
  #revision = 0;

  public commit(): void {
    this.#revision += 1;
  }

  public currentRevision(): number {
    return this.#revision;
  }

  public isGestureActive(): boolean {
    return false;
  }

  public orderByBand(): Readonly<Partial<Record<"content" | "highlight", readonly string[]>>> {
    return {};
  }

  public snapshot() {
    return createMinimalPersistenceFixture(this.#revision);
  }
}

class ManualClock implements AutosaveClock {
  #nextId = 0;
  #now = 0;
  readonly #tasks = new Map<number, { callback: () => void; due: number }>();

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }

  public setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = ++this.#nextId;
    this.#tasks.set(id, { callback, due: this.#now + milliseconds });
    return id;
  }

  public advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (next === undefined) break;
      this.#tasks.delete(next[0]);
      this.#now = next[1].due;
      next[1].callback();
    }
    this.#now = target;
  }
}

class ControlledExecutor implements DocumentRuntimePort {
  readonly acknowledgements: Array<{ accepted: boolean; modelRevision: number }> = [];
  readonly exportRequests: Array<
    Extract<DocumentRuntimeRequest, { type: "export-full" | "export-incremental" }>
  > = [];
  readonly #exports: Array<Deferred<DocumentRuntimeResult>> = [];
  #activeExports = 0;
  maximumActiveExports = 0;

  public execute(request: DocumentRuntimeRequest): Promise<DocumentRuntimeResult> {
    if (request.type === "export-full" || request.type === "export-incremental") {
      const pending = deferred<DocumentRuntimeResult>();
      this.exportRequests.push(request);
      this.#exports.push(pending);
      this.#activeExports += 1;
      this.maximumActiveExports = Math.max(this.maximumActiveExports, this.#activeExports);
      return pending.promise.finally(() => {
        this.#activeExports -= 1;
      });
    }
    if (request.type === "verify-output") {
      const revision = readRevision(request.input);
      return Promise.resolve({
        identity: request.identity,
        persisted:
          revision === null
            ? { type: "unreadable" }
            : { outputHash: hash(revision), revision, type: "confirmed" },
        type: "verify-output-success",
      });
    }
    throw new Error(`Unexpected performance request: ${request.type}`);
  }

  public completeExport(index: number): void {
    const request = this.exportRequests[index];
    const pending = this.#exports[index];
    if (request === undefined || pending === undefined) throw new Error("Missing export request.");
    pending.resolve({
      exportGeneration: request.exportGeneration,
      integrityManifest: deriveDocumentIntegrityManifest(
        createMinimalPersistenceFixture(request.modelRevision),
      ),
      modelRevision: request.modelRevision,
      output: output(request.modelRevision),
      outputHash: hash(request.modelRevision),
      sessionId: request.sessionId,
      type: "export-success",
      workerEpoch: request.workerEpoch,
    } satisfies ExportSuccess);
  }

  public acknowledgeExport(identity: ExportSuccess, accepted: boolean): void {
    this.acknowledgements.push({ accepted, modelRevision: identity.modelRevision });
  }

  public terminate(): void {}
}

class ControlledVault implements ExistingFilePort {
  #activeWrites = 0;
  #content: string;
  #pending: { next: string; result: Deferred<string> } | null = null;
  maximumActiveWrites = 0;
  processCalls = 0;

  public constructor(content: string) {
    this.#content = content;
  }

  public get revision(): number | null {
    return readRevision(this.#content);
  }

  public process(_path: string, update: (current: string) => string): Promise<string> {
    if (this.#pending !== null) throw new Error("Concurrent vault write detected.");
    const result = deferred<string>();
    this.#pending = { next: update(this.#content), result };
    this.processCalls += 1;
    this.#activeWrites += 1;
    this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.#activeWrites);
    return result.promise.finally(() => {
      this.#activeWrites -= 1;
    });
  }

  public readWithMetadataGuard(path: string): Promise<MetadataGuardedFileRead> {
    const size = new TextEncoder().encode(this.#content).byteLength;
    return Promise.resolve({
      content: this.#content,
      identity: { ctime: 1, mtime: 1, path, size },
      materialization: "host-full-read-not-bounded",
      stabilityEvidence: "object-identity-and-stat-unchanged",
    });
  }

  public completeWrite(): void {
    if (this.#pending === null) throw new Error("No vault write is active.");
    const pending = this.#pending;
    this.#pending = null;
    this.#content = pending.next;
    pending.result.resolve(this.#content);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function output(revision: number): string {
  return serializedOutput(revision).svg;
}

function hash(revision: number): string {
  return serializedOutput(revision).hash;
}

const serializedOutputs = new Map<
  number,
  Extract<ReturnType<typeof serializeInkbookDocument>, { readonly ok: true }>["value"]
>();

function serializedOutput(revision: number) {
  const cached = serializedOutputs.get(revision);
  if (cached !== undefined) return cached;
  const serialized = serializeInkbookDocument(createMinimalPersistenceFixture(revision));
  if (!serialized.ok) throw new Error(`Failed to serialize revision ${revision}.`);
  serializedOutputs.set(revision, serialized.value);
  return serialized.value;
}

function readRevision(value: string | Uint8Array): number | null {
  const text = typeof value === "string" ? value : new TextDecoder().decode(value);
  const match = /data-inkbook-revision="(\d+)"/u.exec(text);
  return match === null ? null : Number(match[1]);
}

async function settleUntil(condition: () => boolean, description: string): Promise<void> {
  for (let index = 0; index < 64; index += 1) {
    if (condition()) return;
    await yieldToMainThread();
  }
  throw new Error(`Autosave did not reach ${description}.`);
}
