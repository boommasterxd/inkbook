import type { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { StoreSliceScheduler } from "../../../../src/domain/store/public";
import { VaultDocumentSessionFactory } from "../../../../src/obsidian/embeds/vault-document-session-factory";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
} from "../../../../src/persistence/worker/runtime/public";
import {
  documentFromSnapshot,
  emptySnapshot,
  operation,
  recoveryCopyVaultHarness,
  rectangle,
  TestTFile,
} from "./vault-session-fixtures";

function createFactory(options: {
  readonly create?: (sessionId: string, workerEpoch: number) => Promise<DocumentRuntimePort>;
  readonly createFallback?: (sessionId: string, workerEpoch: number) => DocumentRuntimePort;
  readonly vault: object;
}): VaultDocumentSessionFactory {
  const scheduler = (_documentId: string, isCancelled: () => boolean): StoreSliceScheduler => ({
    isCancelled,
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  const create =
    options.create ??
    (async (sessionId: string, workerEpoch: number) =>
      new DocumentWorkerRuntime({ sessionId, workerEpoch }));
  const createFallback =
    options.createFallback ??
    ((sessionId: string, workerEpoch: number) =>
      new DocumentWorkerRuntime({ sessionId, workerEpoch }));
  const fileManager = {
    trashFile: async (file: TFile) =>
      (options.vault as { trash?: (target: TFile) => Promise<void> }).trash?.(file),
  };
  return new VaultDocumentSessionFactory(options.vault as never, fileManager as never, {
    clock: () => ({ clearTimeout: vi.fn(), setTimeout: vi.fn() }),
    create,
    createFallback,
    createStoreScheduler: scheduler,
    now: () => 1,
  });
}

function documentSessionHarness(options: {
  readonly create?: (sessionId: string, workerEpoch: number) => Promise<DocumentRuntimePort>;
  readonly createFallback?: (sessionId: string, workerEpoch: number) => DocumentRuntimePort;
  readonly document?: ReturnType<typeof documentFromSnapshot>;
}) {
  const document = options.document ?? documentFromSnapshot();
  const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
  const factory = createFactory({
    ...(options.create === undefined ? {} : { create: options.create }),
    ...(options.createFallback === undefined ? {} : { createFallback: options.createFallback }),
    vault: {
      getFileByPath: () => file,
      readBinary: async () => document.bytes.buffer.slice(0),
    },
  });
  return {
    document,
    factory,
    file,
    session: factory.create({ documentId: file.path, sessionId: "session-1" }),
  };
}

async function unlockWithRectangle(
  factory: VaultDocumentSessionFactory,
  session: ReturnType<VaultDocumentSessionFactory["create"]>,
) {
  await session.unlock(operation());
  const model = factory.getDocumentModel("session-1");
  model?.commitElement(rectangle());
  return model;
}

function recoveryCopyHarness() {
  const document = documentFromSnapshot();
  const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
  const copyHarness = recoveryCopyVaultHarness({
    file,
    getDocument: () => document,
    getContent: () => document.svg,
  });
  const factory = createFactory({ vault: copyHarness.vault });
  return {
    createdCopies: copyHarness.createdCopies,
    factory,
    holdCopyRead: copyHarness.holdCopyRead,
    session: factory.create({ documentId: file.path, sessionId: "session-1" }),
  };
}

describe("VaultDocumentSession editor context lifecycle", () => {
  it("retains one editor history for the session and clears it on disposal", async () => {
    const { factory, session } = documentSessionHarness({});
    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "active" });
    const firstPresentation = factory.getEditorContext("session-1");
    if (firstPresentation === undefined) throw new Error("Expected an editor context.");

    expect(firstPresentation.history.create([rectangle()])).toBe(true);
    const handedOffPresentation = factory.getEditorContext("session-1");
    expect(handedOffPresentation?.history).toBe(firstPresentation.history);
    expect(handedOffPresentation?.history.undo()).toBe(true);
    expect(handedOffPresentation?.model.store.size).toBe(0);
    expect(handedOffPresentation?.history.redo()).toBe(true);
    expect(handedOffPresentation?.model.store.size).toBe(1);

    session.dispose();

    expect(factory.getEditorContext("session-1")).toBeUndefined();
    expect(firstPresentation.history.commandCount).toBe(0);
    expect(firstPresentation.history.canUndo).toBe(false);
  });
});

describe("VaultDocumentSession terminal executor lifecycle", () => {
  it("starts the guarded Vault read while worker construction is pending", async () => {
    const document = documentFromSnapshot();
    const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
    let resolveWorker: ((runtime: DocumentRuntimePort) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<DocumentRuntimePort>((resolve) => {
          resolveWorker = resolve;
        }),
    );
    const readBinary = vi.fn(async () => document.bytes.buffer.slice(0));
    const factory = createFactory({
      create,
      vault: { getFileByPath: () => file, readBinary },
    });
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });

    const unlocking = session.unlock(operation());
    await vi.waitFor(() => expect(readBinary).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
    resolveWorker?.(new DocumentWorkerRuntime({ sessionId: "session-1", workerEpoch: 1 }));

    await expect(unlocking).resolves.toMatchObject({ status: "active" });
    expect(readBinary).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("retries a failed worker unlock exactly once in the bounded fallback", async () => {
    const terminate = vi.fn();
    const primary: DocumentRuntimePort = {
      execute: vi.fn(() => Promise.reject(new Error("worker timed out"))),
      terminate,
    };
    const createFallback = vi.fn(
      (sessionId: string, epoch: number) =>
        new DocumentWorkerRuntime({ sessionId, workerEpoch: epoch }),
    );
    const { session } = documentSessionHarness({
      create: async () => primary,
      createFallback,
    });

    await expect(session.unlock(operation())).resolves.toMatchObject({
      status: "active",
      workerEpoch: 2,
    });
    expect(terminate).toHaveBeenCalledOnce();
    expect(createFallback).toHaveBeenCalledOnce();
    expect(createFallback).toHaveBeenCalledWith("session-1", 2, expect.any(Function));
  });

  it("reads fresh Vault bytes after a failed primary unlock", async () => {
    const first = documentFromSnapshot();
    const second = documentFromSnapshot({ ...emptySnapshot(), revision: 8 });
    const file = new TestTFile("drawings/ink.svg", first.bytes.byteLength);
    const readBinary = vi
      .fn()
      .mockResolvedValueOnce(first.bytes.buffer.slice(0))
      .mockResolvedValueOnce(second.bytes.buffer.slice(0));
    const primary: DocumentRuntimePort = {
      execute: () => Promise.reject(new Error("worker failed")),
      terminate: vi.fn(),
    };
    const factory = createFactory({
      create: async () => primary,
      vault: { getFileByPath: () => file, readBinary },
    });
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });

    await expect(session.unlock(operation())).resolves.toMatchObject({
      status: "active",
      workerEpoch: 2,
    });
    expect(readBinary).toHaveBeenCalledTimes(2);
    expect(factory.getDocumentModel("session-1")?.revision).toBe(8);
    session.dispose();
  });
});

describe("VaultDocumentSession live executor lifecycle", () => {
  it("avoids eager export prewarming and mirrors live gesture state", async () => {
    const core = new DocumentWorkerRuntime({ sessionId: "session-1", workerEpoch: 1 });
    const requestPrewarm = vi.fn(() => core.requestPrewarm());
    const setLiveInputActive = vi.fn((active: boolean) => core.setLiveInputActive(active));
    const runtime: DocumentRuntimePort = {
      execute: (request, observer) => core.execute(request, observer),
      requestPrewarm,
      setLiveInputActive,
      terminate: () => core.terminate(),
    };
    const { factory, session } = documentSessionHarness({
      create: async () => runtime,
    });

    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "active" });
    const model = factory.getDocumentModel("session-1");
    model?.setGestureActive(true);
    model?.setNavigationActive?.(true);
    model?.setNavigationActive?.(true);
    const resumed = vi.fn();
    const waiting = model?.waitForBackground?.().then(resumed);
    await Promise.resolve();
    expect(resumed).not.toHaveBeenCalled();
    model?.setGestureActive(false);
    await Promise.resolve();
    expect(resumed).not.toHaveBeenCalled();
    model?.setNavigationActive?.(false);
    await waiting;
    expect(resumed).toHaveBeenCalledOnce();

    expect(requestPrewarm).not.toHaveBeenCalled();
    expect(setLiveInputActive.mock.calls).toEqual([[true], [false]]);
  });

  it("does not construct a fallback after disposal wins worker failure", async () => {
    const document = documentFromSnapshot();
    const file = new TestTFile("drawings/ink.svg", document.bytes.byteLength);
    let rejectRuntime: ((error: Error) => void) | undefined;
    const create = vi.fn(
      () =>
        new Promise<DocumentRuntimePort>((_resolve, reject) => {
          rejectRuntime = reject;
        }),
    );
    const createFallback = vi.fn(
      (sessionId: string, epoch: number) =>
        new DocumentWorkerRuntime({ sessionId, workerEpoch: epoch }),
    );
    const readBinary = vi.fn(async () => document.bytes.buffer.slice(0));
    const factory = createFactory({
      create,
      createFallback,
      vault: { getFileByPath: () => file, readBinary },
    });
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });

    const unlocking = session.unlock(operation());
    session.dispose();
    rejectRuntime?.(new Error("late worker construction failure"));

    await expect(unlocking).resolves.toMatchObject({ status: "load-error" });
    expect(createFallback).not.toHaveBeenCalled();
    expect(readBinary).not.toHaveBeenCalled();
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
  });
});

describe("VaultDocumentSession clipboard executor recovery", () => {
  it("hydrates one fallback epoch and retries clipboard encoding exactly once", async () => {
    const primaryCore = new DocumentWorkerRuntime({ sessionId: "session-1", workerEpoch: 1 });
    let rejectClipboard = true;
    const primary: DocumentRuntimePort = {
      execute: (request, observer) => {
        if (request.type === "clipboard-encode" && rejectClipboard) {
          rejectClipboard = false;
          return Promise.reject(new Error("worker crashed during clipboard encoding"));
        }
        return primaryCore.execute(request, observer);
      },
      terminate: () => primaryCore.terminate(),
    };
    const createFallback = vi.fn(
      (sessionId: string, epoch: number) =>
        new DocumentWorkerRuntime({ sessionId, workerEpoch: epoch }),
    );
    const { factory, session } = documentSessionHarness({
      create: async () => primary,
      createFallback,
    });
    const model = await unlockWithRectangle(factory, session);

    const encoded = await model?.encodeClipboard(new Set([rectangle().id]));

    expect(encoded?.customText).toContain("inkbook-elements");
    expect(createFallback).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({ dirty: true, revision: 8, workerEpoch: 2 });
  });
});

describe("VaultDocumentSession exact recovery lifecycle", () => {
  it("reloads through the existing document worker instead of constructing a second worker", async () => {
    const document = documentFromSnapshot();
    const create = vi.fn(
      async (sessionId: string, workerEpoch: number) =>
        new DocumentWorkerRuntime({ sessionId, workerEpoch }),
    );
    const { session } = documentSessionHarness({ create, document });
    await session.unlock(operation());

    await expect(
      session.resolveRecovery("reload-external", { ...operation(), operationId: 2 }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps the dirty model when cancellation interrupts external reload", async () => {
    const initial = documentFromSnapshot();
    const external = documentFromSnapshot({
      ...emptySnapshot(),
      elements: [rectangle()],
      revision: 12,
    });
    const file = new TestTFile("drawings/ink.svg", initial.bytes.byteLength);
    let readCount = 0;
    let releaseRead = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readBinary = vi.fn(async () => {
      readCount += 1;
      if (readCount === 1) return initial.bytes.buffer.slice(0);
      await readGate;
      return external.bytes.buffer.slice(0);
    });
    const factory = createFactory({ vault: { getFileByPath: () => file, readBinary } });
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });
    await session.unlock(operation());
    const originalModel = factory.getDocumentModel("session-1");
    originalModel?.commitElement(rectangle());
    const recoveryOperation = { ...operation(), baseRevision: 8, operationId: 2 };

    file.stat.size = external.bytes.byteLength;
    const recovery = session.resolveRecovery("reload-external", recoveryOperation);
    await vi.waitFor(() => expect(readBinary).toHaveBeenCalledTimes(2));
    session.cancelOperation(recoveryOperation);
    releaseRead();

    await expect(recovery).resolves.toMatchObject({ status: "failed" });
    expect(factory.getDocumentModel("session-1")).toBe(originalModel);
    expect(originalModel?.revision).toBe(8);
    expect(session.getSnapshot().dirty).toBe(true);
  });

  it("rejects a recovery whose exact base revision is stale", async () => {
    const { createdCopies, factory, session } = recoveryCopyHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());

    await expect(
      session.resolveRecovery("save-local-copy", { ...operation(), operationId: 2 }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(createdCopies.size).toBe(0);
  });

  it("trashes an in-flight recovery artifact after disposal", async () => {
    const { createdCopies, factory, holdCopyRead, session } = recoveryCopyHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());
    const releaseCopyRead = holdCopyRead();
    const recovery = session.resolveRecovery("save-local-copy", {
      ...operation(),
      baseRevision: 8,
      operationId: 2,
    });
    await vi.waitFor(() => expect(createdCopies.has("drawings/ink-recovered-1.svg")).toBe(true));

    session.dispose();
    releaseCopyRead();

    await expect(recovery).resolves.toMatchObject({ status: "failed" });
    expect(createdCopies.has("drawings/ink-recovered-1.svg")).toBe(false);
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
  });
});
