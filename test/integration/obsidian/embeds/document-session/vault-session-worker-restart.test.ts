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
