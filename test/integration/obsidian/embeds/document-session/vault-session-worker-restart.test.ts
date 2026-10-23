import { expect, it, vi } from "vitest";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
  type DocumentRuntimeRequest,
} from "../../../../../src/persistence/worker/runtime/public";
import {
  createReadOnlyVaultSession,
  documentFromSnapshot,
  operation,
  rectangle,
} from "./vault-session-fixtures";

function createRestartHarness() {
  const requests: DocumentRuntimeRequest[][] = [];
  const terminations: ReturnType<typeof vi.fn>[] = [];
  const inputFlags: ReturnType<typeof vi.fn>[] = [];
  const navigationFlags: ReturnType<typeof vi.fn>[] = [];
  const failures = new Set<number>();
  const create = vi.fn(async (sessionId: string, workerEpoch: number) => {
    const core = new DocumentWorkerRuntime({ sessionId, workerEpoch });
    const currentRequests: DocumentRuntimeRequest[] = [];
    requests.push(currentRequests);
    const executor = {
      execute: vi.fn<DocumentRuntimePort["execute"]>((request, observer) => {
        currentRequests.push(request);
        if (failures.has(workerEpoch) && request.type === "clipboard-encode")
          return Promise.reject(new Error("worker crashed"));
        return core.execute(request, observer);
      }),
      setLiveInputActive: vi.fn(),
      setNavigationActive: vi.fn(),
      terminate: vi.fn(() => core.terminate()),
    };
    terminations.push(vi.mocked(executor.terminate));
    inputFlags.push(executor.setLiveInputActive);
    navigationFlags.push(executor.setNavigationActive);
    return executor;
  });
  const session = createReadOnlyVaultSession(documentFromSnapshot(), create);
  return { ...session, create, failures, terminations, inputFlags, navigationFlags, requests };
}

it("resynchronizes the authoritative dirty Store while preserving history and scene ownership", async () => {
  const fixture = createRestartHarness();
  try {
    await fixture.session.unlock(operation());
    const context = fixture.session.editorContext!;
    const { model, history } = context;
    const store = model.store;
    const scenePaths = model.prepareScenePaths;
    expect(history.create([rectangle()])).toBe(true);
    model.setGestureActive(true);
    model.setNavigationActive?.(true);
    fixture.failures.add(1);

    const encoded = await model.encodeClipboard(new Set([rectangle().id]));

    expect(encoded?.customText).toContain("inkbook-elements");
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.terminations[0]).toHaveBeenCalledOnce();
    expect(fixture.inputFlags[1]).toHaveBeenCalledWith(true);
    expect(fixture.navigationFlags[1]).toHaveBeenCalledWith(true);
    expect(fixture.requests[1]?.map(({ type }) => type)).toEqual([
      "model-sync-full",
      "clipboard-encode",
    ]);
    expect(fixture.requests[1]?.[0]).toMatchObject({
      snapshot: { revision: 8, elements: [rectangle()] },
    });
    expect(fixture.session.editorContext).toEqual(context);
    expect(fixture.session.documentModel?.store).toBe(store);
    expect(fixture.session.documentModel?.prepareScenePaths).toBe(scenePaths);
    expect(fixture.session.getSnapshot()).toMatchObject({
      dirty: true,
      revision: 8,
      confirmedRevision: 7,
      workerEpoch: 2,
    });
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toBe(true);
    expect(model.store.get(rectangle().id)).toBeUndefined();
    expect(fixture.session.getSnapshot()).toMatchObject({ dirty: true, revision: 9 });
  } finally {
    fixture.session.dispose();
  }
  expect(fixture.terminations[1]).toHaveBeenCalledOnce();
});

it("performs no second native restart after the replacement fails", async () => {
  const fixture = createRestartHarness();
  try {
    await fixture.session.unlock(operation());
    const model = fixture.session.documentModel!;
    model.commitElement(rectangle());
    fixture.failures.add(1);
    expect(await model.encodeClipboard(new Set([rectangle().id]))).not.toBeNull();
    fixture.failures.add(2);
    expect(await model.encodeClipboard(new Set([rectangle().id]))).not.toBeNull();
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.terminations[1]).toHaveBeenCalledOnce();
    expect(fixture.session.getSnapshot()).toMatchObject({
      workerEpoch: 3,
      revision: 8,
      dirty: true,
    });
  } finally {
    fixture.session.dispose();
  }
});

it("terminates a late replacement after disposal without reviving the session", async () => {
  let release!: (executor: DocumentRuntimePort) => void;
  let started!: () => void;
  const restarting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const core = new DocumentWorkerRuntime({ sessionId: "session-1", workerEpoch: 1 });
  const primary: DocumentRuntimePort = {
    execute: (request, observer) =>
      request.type === "clipboard-encode"
        ? Promise.reject(new Error("worker crashed"))
        : core.execute(request, observer),
    terminate: vi.fn(() => core.terminate()),
  };
  const create = vi.fn(async (_sessionId: string, epoch: number) => {
    if (epoch === 1) return primary;
    started();
    return new Promise<DocumentRuntimePort>((resolve) => {
      release = resolve;
    });
  });
  const fixture = createReadOnlyVaultSession(documentFromSnapshot(), create);
  await fixture.session.unlock(operation());
  const model = fixture.session.documentModel!;
  model.commitElement(rectangle());
  const encoding = model.encodeClipboard(new Set([rectangle().id]));
  await restarting;
  fixture.session.dispose();
  const replacement = { execute: vi.fn(), terminate: vi.fn() };
  release(replacement);
  expect(await encoding).toBeNull();
  expect(replacement.terminate).toHaveBeenCalledOnce();
  expect(replacement.execute).not.toHaveBeenCalled();
  expect(fixture.session.documentModel).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(2);
});

it("repairs an incremental model mismatch for the same clipboard call without replacing the worker", async () => {
  const requests: DocumentRuntimeRequest[] = [];
  const create = vi.fn(async (sessionId: string, workerEpoch: number) => {
    const core = new DocumentWorkerRuntime({ sessionId, workerEpoch });
    return {
      execute: (
        request: DocumentRuntimeRequest,
        observer?: Parameters<DocumentRuntimePort["execute"]>[1],
      ) => {
        requests.push(request);
        if (request.type === "model-sync-incremental")
          return Promise.resolve({
            type: "runtime-failure" as const,
            identity: request.identity,
            retryable: true,
            code: "base-revision-mismatch",
          });
        return core.execute(request, observer);
      },
      terminate: () => core.terminate(),
    };
  });
  const fixture = createReadOnlyVaultSession(documentFromSnapshot(), create);
  try {
    await fixture.session.unlock(operation());
    const { model, history } = fixture.session.editorContext!;
    history.create([rectangle()]);
    expect(await model.encodeClipboard(new Set([rectangle().id]))).not.toBeNull();
    expect(requests.map(({ type }) => type)).toEqual([
      "unlock",
      "model-sync-incremental",
      "model-sync-full",
      "clipboard-encode",
    ]);
    expect(fixture.session.getSnapshot()).toMatchObject({
      revision: 8,
      confirmedRevision: 7,
      dirty: true,
      workerEpoch: 1,
    });
    expect(history.canUndo).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  } finally {
    fixture.session.dispose();
  }
});

it("starts no replacement after cancellation wins a failed initial worker construction", async () => {
  let rejectInitial!: (error: Error) => void;
  const create = vi.fn((sessionId: string, workerEpoch: number) => {
    if (create.mock.calls.length > 1)
      return Promise.resolve(new DocumentWorkerRuntime({ sessionId, workerEpoch }));
    return new Promise<DocumentRuntimePort>((_resolve, reject) => {
      rejectInitial = reject;
    });
  });
  const fixture = createReadOnlyVaultSession(documentFromSnapshot(), create);
  try {
    const unlockOperation = operation();
    const unlocking = fixture.session.unlock(unlockOperation);
    expect(create).toHaveBeenCalledOnce();
    fixture.session.cancelOperation(unlockOperation);
    rejectInitial(new Error("initial worker bootstrap failed"));
    expect(await unlocking).toMatchObject({ status: "load-error", workerEpoch: 1 });
    expect(create).toHaveBeenCalledOnce();
    expect(fixture.session.documentModel).toBeUndefined();

    expect(await fixture.session.unlock(unlockOperation)).toMatchObject({ status: "active" });
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    fixture.session.dispose();
  }
});

it.each([false, true])(
  "cancels a pending native replacement without adoption or fallback, success=%s",
  async (success) => {
    let resolveReplacement!: (executor: DocumentRuntimePort) => void;
    let rejectReplacement!: (error: Error) => void;
    let replacementStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    const create = vi.fn((sessionId: string, workerEpoch: number): Promise<DocumentRuntimePort> => {
      if (create.mock.calls.length === 1)
        return Promise.reject(new Error("initial construction failed"));
      if (create.mock.calls.length > 2)
        return Promise.resolve(new DocumentWorkerRuntime({ sessionId, workerEpoch }));
      replacementStarted();
      return new Promise<DocumentRuntimePort>((resolve, reject) => {
        resolveReplacement = resolve;
        rejectReplacement = reject;
      });
    });
    const fixture = createReadOnlyVaultSession(documentFromSnapshot(), create);
    const candidate = { execute: vi.fn<DocumentRuntimePort["execute"]>(), terminate: vi.fn() };
    try {
      const unlocking = fixture.session.unlock(operation());
      await started;
      fixture.session.cancelOperation(operation());
      if (success) resolveReplacement(candidate);
      else rejectReplacement(new Error("replacement construction failed"));
      expect(await unlocking).toMatchObject({ status: "load-error", workerEpoch: 1 });
      expect(create).toHaveBeenCalledTimes(2);
      expect(candidate.execute).not.toHaveBeenCalled();
      expect(candidate.terminate).toHaveBeenCalledTimes(success ? 1 : 0);
      expect(fixture.session.documentModel).toBeUndefined();
      expect(await fixture.session.unlock(operation())).toMatchObject({
        status: "active",
        workerEpoch: 1,
      });
      expect(create).toHaveBeenCalledTimes(3);
    } finally {
      fixture.session.dispose();
    }
  },
);
