import { describe, expect, it, vi } from "vitest";

import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import type { MetadataGuardedFileRead } from "../../../../src/persistence/saving/save-ports";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
  type DocumentRuntimeRequest,
  type DocumentRuntimeResult,
} from "../../../../src/persistence/worker/runtime/public";
import { rectangle, snapshot } from "../../../unit/persistence/worker/runtime/fixtures";
import { AutosaveDocumentFixture, serializeSnapshot } from "./fixtures";

class DisposeRaceVault {
  processCount = 0;
  readCount = 0;
  readGate: Promise<void> | null = null;
  readonly #content: string;
  #releaseReadCount: (() => void) | undefined;

  constructor(content: string) {
    this.#content = content;
  }

  async process(_path: string, update: (current: string) => string): Promise<string> {
    this.processCount += 1;
    return update(this.#content);
  }

  async readWithMetadataGuard(path: string): Promise<MetadataGuardedFileRead> {
    this.readCount += 1;
    this.#releaseReadCount?.();
    if (this.readGate !== null) await this.readGate;
    return {
      content: this.#content,
      identity: { ctime: 1, mtime: 1, path, size: this.#content.length },
      materialization: "host-full-read-not-bounded",
      stabilityEvidence: "object-identity-and-stat-unchanged",
    };
  }

  waitForRead(): Promise<void> {
    if (this.readCount > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#releaseReadCount = resolve;
    });
  }
}

function createCoordinator(
  executor: DocumentRuntimePort,
  documentSource: AutosaveDocumentFixture,
  vault: DisposeRaceVault,
  lazyConfirmedContent = false,
  createFallback?: (workerEpoch: number) => DocumentRuntimePort,
): AutosaveCoordinator {
  const initial = serializeSnapshot();
  return new AutosaveCoordinator({
    clock: { clearTimeout: vi.fn(), setTimeout: vi.fn() },
    confirmedBase: { outputHash: initial.hash, revision: 0, type: "confirmed" },
    ...(lazyConfirmedContent ? {} : { confirmedContent: initial.svg }),
    ...(createFallback === undefined ? {} : { createFallback }),
    documentSource,
    executor,
    initialSnapshot: snapshot(),
    path: "drawing.svg",
    sessionId: "session-a",
    vault,
    workerEpoch: 1,
  });
}

function recordCommit(
  coordinator: AutosaveCoordinator,
  documentSource: AutosaveDocumentFixture,
): void {
  documentSource.commit(1, 235);
  coordinator.recordCommit({ changedElements: [rectangle(235)], modelRevision: 1 });
}

describe("AutosaveCoordinator terminal export disposal", () => {
  it("suppresses late export failure and fallback construction", async () => {
    const documentSource = new AutosaveDocumentFixture();
    const vault = new DisposeRaceVault(serializeSnapshot().svg);
    let rejectExport: ((error: Error) => void) | undefined;
    const executor: DocumentRuntimePort = {
      execute: () =>
        new Promise((_, reject) => {
          rejectExport = reject;
        }),
      terminate: vi.fn(),
    };
    const createFallback = vi.fn(
      (epoch: number) => new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: epoch }),
    );
    const coordinator = createCoordinator(executor, documentSource, vault, false, createFallback);
    recordCommit(coordinator, documentSource);
    const flush = coordinator.flush("retry");

    coordinator.dispose();
    rejectExport?.(new Error("late export failure"));

    await expect(flush).resolves.toBe("executor-failed");
    await Promise.resolve();
    expect(createFallback).not.toHaveBeenCalled();
    expect(vault.processCount).toBe(0);
    expect(vault.readCount).toBe(0);
    expect(coordinator.status).toBe("executor-failed");
  });

  it("suppresses a valid late export result without vault IO", async () => {
    const documentSource = new AutosaveDocumentFixture();
    const vault = new DisposeRaceVault(serializeSnapshot().svg);
    let request: DocumentRuntimeRequest | undefined;
    let resolveExport: ((result: DocumentRuntimeResult) => void) | undefined;
    const executor: DocumentRuntimePort = {
      execute: (candidate) => {
        request = candidate;
        return new Promise<DocumentRuntimeResult>((resolve) => {
          resolveExport = resolve;
        });
      },
      terminate: vi.fn(),
    };
    const coordinator = createCoordinator(executor, documentSource, vault);
    recordCommit(coordinator, documentSource);
    const flush = coordinator.flush("retry");
    const pending = request;
    if (
      pending === undefined ||
      (pending.type !== "export-full" && pending.type !== "export-incremental")
    ) {
      throw new Error("Expected a pending export request.");
    }
    const output = serializeSnapshot(documentSource.value);

    coordinator.dispose();
    resolveExport?.({
      exportGeneration: pending.exportGeneration,
      modelRevision: pending.modelRevision,
      output: output.svg,
      outputHash: output.hash,
      sessionId: pending.sessionId,
      type: "export-success",
      workerEpoch: pending.workerEpoch,
    });

    await expect(flush).resolves.toBe("executor-failed");
    await Promise.resolve();
    expect(vault.processCount).toBe(0);
    expect(vault.readCount).toBe(0);
    expect(coordinator.status).toBe("executor-failed");
  });
});

describe("AutosaveCoordinator terminal persistence disposal", () => {
  it("stops after disposal interrupts an exact-base preflight", async () => {
    const documentSource = new AutosaveDocumentFixture();
    const initial = serializeSnapshot();
    const vault = new DisposeRaceVault(initial.svg);
    let releaseRead = (): void => undefined;
    vault.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const executor = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
    await executor.execute({
      identity: { operationId: 1, purpose: "unlock", sessionId: "session-a", workerEpoch: 1 },
      input: initial.svg,
      type: "unlock",
    });
    const coordinator = createCoordinator(executor, documentSource, vault, true);
    recordCommit(coordinator, documentSource);
    const flush = coordinator.flush("retry");
    await vault.waitForRead();

    coordinator.dispose();
    vault.readGate = null;
    releaseRead();

    await expect(flush).resolves.toBe("executor-failed");
    await Promise.resolve();
    expect(vault.readCount).toBe(1);
    expect(vault.processCount).toBe(0);
    expect(coordinator.status).toBe("executor-failed");
  });
});
