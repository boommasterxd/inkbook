import { describe, expect, it, vi } from "vitest";
import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../../src/domain/store/public";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/document-model-port";
import {
  CreationPreview,
  type CreationPreviewOptions,
} from "../../../../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import {
  activeEditorStoreHistory,
  creationPreviewRenderer,
} from "../../../../../fixtures/obsidian/active-editor";
import { elementReplacementPorts } from "../../../../../fixtures/obsidian/element-mutation-ports";
import { pausedWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import { connectedLine, rectangle } from "../../../../domain/store/fixtures";
import { uuid } from "../../../../domain/schema/fixtures";

function fixture(start = { x: 50, y: 50 }, refinementSignal?: AbortSignal) {
  const target = rectangle();
  const store = new ElementStore([target]);
  const scene = new ElementSceneStore(store);
  const beginQuery = vi.spyOn(scene, "beginQuery");
  let revision = 0;
  const unsubscribe = store.subscribe(() => {
    revision += 1;
  });
  let current = true;
  let enabled = true;
  const { scheduler, pause, resume } = pausedWorkScheduler();
  const releaseOperation = vi.fn();
  const model = {
    store,
    ...elementReplacementPorts(store),
    beginInteractiveOperation: () => releaseOperation,
  } as unknown as EditableDocumentModel;
  const setLivePath = vi.fn();
  const renderer = creationPreviewRenderer({ setLivePath, commitLivePath: vi.fn() });
  const history = activeEditorStoreHistory(store);
  const options: CreationPreviewOptions = {
    defaults: createBuiltInSettings().toolDefaults,
    history,
    model,
    identity: { createdAt: 2, id: uuid(20) },
    isCurrent: () => current,
    readRevision: () => revision,
    ...(refinementSignal === undefined ? {} : { refinementSignal }),
    renderer,
    snap: {
      angles: false,
      connections: () => enabled,
      pageToScreen: (point) => point,
      spatial: scene,
      targets: { get: (id, bounds) => scene.getSnapTarget(id, bounds) },
      zoom: 1,
    },
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType: "mouse", ...start },
      tool: "line",
    },
    workScheduler: scheduler,
  };
  const preview = new CreationPreview(options);
  expect(beginQuery).toHaveBeenCalledOnce();
  return {
    target,
    store,
    scene,
    model,
    renderer,
    setLivePath,
    history,
    preview,
    releaseOperation,
    options,
    detach: () => {
      current = false;
    },
    disable: () => {
      enabled = false;
    },
    pause,
    resume,
    cleanup: () => {
      preview.revert();
      unsubscribe();
      scene.release();
    },
  };
}

type Action =
  | "commit"
  | "create-undo-newer"
  | "moved-target"
  | "detach"
  | "cancel"
  | "undo"
  | "undo-redo"
  | "dependent";
function intervene(action: Action, state: ReturnType<typeof fixture>): void {
  const { history, store, target, preview } = state;
  if (action === "detach") state.detach();
  if (action === "cancel") preview.revert();
  if (action === "undo" || action === "undo-redo") history.undo();
  if (action === "undo-redo") history.redo();
  if (action === "create-undo-newer") {
    history.create([rectangle(uuid(21), 500, 500)]);
    history.undo();
  }
  if (action === "moved-target")
    store.replace(target.id, { ...target, x: 500, pivot: { x: 600, y: 150 } });
  if (action === "dependent")
    history.create([
      {
        ...connectedLine(),
        id: uuid(21),
        start: { x: 98, y: 99 },
        end: { x: 300, y: 300 },
        pivot: { x: 199, y: 199.5 },
        startConnection: {
          anchor: { kind: "linear-endpoint", endpoint: "end" },
          targetId: uuid(20),
        },
      },
    ]);
}

describe("authoritative creation before deferred snap refinement", () => {
  it.each<Action>([
    "commit",
    "create-undo-newer",
    "moved-target",
    "detach",
    "cancel",
    "undo",
    "undo-redo",
    "dependent",
  ])("preserves drawing and original history ownership during %s", async (action) => {
    const state = fixture();
    const { preview, store, history, target } = state;
    preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
    expect(preview.commit()).toBe(true);
    expect(store.get(uuid(20))?.element).toMatchObject({
      end: { x: 98, y: 99 },
      endConnection: null,
    });
    expect(history.commandCount).toBe(1);
    const retainedBytes = history.retainedPayloadBytes;
    intervene(action, state);
    state.resume();
    const refined = action === "commit" || action === "create-undo-newer";
    expect(await preview.completion).toBe(refined);
    if (action !== "undo")
      expect(store.get(uuid(20))?.element).toMatchObject({
        end: refined ? { x: 100, y: 100 } : { x: 98, y: 99 },
        endConnection: refined ? { targetId: target.id } : null,
      });
    if (action === "undo") expect(store.get(uuid(20))).toBeUndefined();
    if (refined) {
      expect(history.undo()).toBe(true);
      expect(store.get(uuid(20))).toBeUndefined();
      expect(history.redo()).toBe(true);
      expect(store.get(uuid(20))?.element).toMatchObject({
        end: { x: 100, y: 100 },
        endConnection: { targetId: target.id },
      });
    }
    if (action === "commit") expect(history.retainedPayloadBytes).toBe(retainedBytes);
    expect(state.releaseOperation).toHaveBeenCalledOnce();
    state.cleanup();
  });
});

describe("deferred snap causality and overrides", () => {
  it("keeps creation order and excludes a target created after the raw line", async () => {
    const state = fixture();
    state.preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
    state.preview.commit();
    const newer = rectangle(uuid(21));
    state.history.create([newer]);
    state.resume();
    expect(await state.preview.completion).toBe(true);
    expect(state.store.materializeBandOrder("content")).toEqual([
      state.target.id,
      uuid(20),
      newer.id,
    ]);
    expect(state.store.get(uuid(20))?.element).toMatchObject({
      endConnection: { targetId: state.target.id },
    });
    state.history.undo();
    state.history.undo();
    expect(state.history.redo()).toBe(true);
    expect(state.store.get(uuid(20))?.element).toMatchObject({
      endConnection: { targetId: state.target.id },
    });
    expect(state.history.redo()).toBe(true);
    state.cleanup();
  });

  it("cancels pending lookup when the snapping override disables connections", async () => {
    const state = fixture();
    state.disable();
    state.preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
    expect(state.preview.commit()).toBe(true);
    state.resume();
    expect(await state.preview.completion).toBe(true);
    expect(state.store.get(uuid(20))?.element).toMatchObject({
      end: { x: 98, y: 99 },
      endConnection: null,
    });
    state.cleanup();
  });
});

describe("refinement history ownership", () => {
  it("releases the cancellation callback after refinement settlement", () => {
    const store = new ElementStore();
    const history = activeEditorStoreHistory(store);
    const cancel = vi.fn();
    const line = { ...connectedLine(), startConnection: null };
    const retained = history.createRefinable(line, cancel)!;
    expect(retained.canRefine(line)).toBe(true);
    retained.finish();
    expect(retained.canRefine(line)).toBe(false);
    expect(history.undo()).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(history.redo()).toBe(true);
    expect(store.get(line.id)?.element).toEqual(line);
  });

  it("preserves the raw drawing when an unrelated asynchronous Undo overlaps refinement", async () => {
    const state = fixture();
    state.preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
    state.preview.commit();
    const newer = rectangle(uuid(21), 500, 500);
    state.store.create([newer]);
    let releaseUndo: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const undoStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    state.history.registerApplied({
      payloadBytes: 512,
      redo: async () => {
        state.store.create([newer]);
        return true;
      },
      undo: async () => {
        markStarted();
        await new Promise<void>((resolve) => {
          releaseUndo = resolve;
        });
        state.store.remove([newer.id]);
        return true;
      },
    });
    const undo = state.history.undoAsync();
    await undoStarted;
    state.resume();
    expect(await state.preview.completion).toBe(false);
    expect(state.store.get(uuid(20))?.element).toMatchObject({ end: { x: 98, y: 99 } });
    releaseUndo();
    expect(await undo).toBe(true);
    expect(state.store.get(newer.id)).toBeUndefined();
    expect(state.store.get(uuid(20))).toBeDefined();
    expect(state.history.undo()).toBe(true);
    expect(state.store.get(uuid(20))).toBeUndefined();
    state.cleanup();
  });
});

describe("creation snap handoff", () => {
  it("clears live feedback and cancels lookup when the native create boundary fails", async () => {
    const state = fixture();
    state.preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
    const create = vi.spyOn(state.store, "create").mockImplementation(() => {
      throw new RangeError("Document element capacity exceeded.");
    });
    expect(() => state.preview.commit()).toThrow("Document element capacity exceeded.");
    expect(state.setLivePath).toHaveBeenLastCalledWith(null);
    expect(state.history.commandCount).toBe(0);
    const writes = state.setLivePath.mock.calls.length;
    state.resume();
    await Promise.resolve();
    expect(state.setLivePath.mock.calls.length).toBe(writes);
    expect(state.store.get(uuid(20))).toBeUndefined();
    create.mockRestore();
    state.cleanup();
  });

  it("preserves the painted start anchor when release exhausts the shared budget", async () => {
    const state = fixture({ x: 98, y: 99 });
    const painted = new Promise<void>((resolve) => {
      state.setLivePath.mockImplementation(() => {
        resolve();
      });
    });
    state.resume();
    await painted;
    state.pause();
    state.preview.update({ pointerId: 1, pointerType: "mouse", x: 400, y: 300 });
    expect(state.preview.commit()).toBe(true);
    expect(state.store.get(uuid(20))?.element).toMatchObject({
      start: { x: 100, y: 100 },
      startConnection: { targetId: state.target.id },
    });
    state.resume();
    await state.preview.completion;
    state.cleanup();
  });
});

describe("new input refinement ownership", () => {
  it("keeps an older raw line stable while a new line snaps to it", async () => {
    const input = new AbortController();
    const state = fixture(undefined, input.signal);
    const prepare = vi.spyOn(state.model, "prepareElementReplacement");
    state.preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
    expect(state.preview.commit()).toBe(true);
    expect(input.signal.aborted).toBe(false);
    const raw = state.store.get(uuid(20));
    input.abort();
    const second = new CreationPreview({
      ...state.options,
      identity: { id: uuid(21), createdAt: 3 },
      refinementSignal: new AbortController().signal,
      workScheduler: { ...state.options.workScheduler!, shouldYield: () => false },
      start: {
        ...state.options.start,
        pointer: { pointerId: 2, pointerType: "mouse", x: 98, y: 99 },
      },
    });
    second.update({ pointerId: 2, pointerType: "mouse", x: 300, y: 400 });
    const writes = state.setLivePath.mock.calls.length;
    state.resume();
    expect(await state.preview.completion).toBe(false);
    expect(state.store.get(uuid(20))).toBe(raw);
    expect(state.setLivePath.mock.calls.length).toBe(writes);
    expect(prepare).not.toHaveBeenCalled();
    expect(second.commit()).toBe(true);
    expect(state.store.get(uuid(21))?.element).toMatchObject({
      start: { x: 98, y: 99 },
      startConnection: { targetId: uuid(20), anchor: { kind: "linear-endpoint", endpoint: "end" } },
    });
    expect(state.history.undo()).toBe(true);
    expect(state.store.get(uuid(21))).toBeUndefined();
    expect(state.store.get(uuid(20))).toBe(raw);
    expect(state.history.undo()).toBe(true);
    expect(state.store.get(uuid(20))).toBeUndefined();
    expect(state.history.redo()).toBe(true);
    expect(state.history.redo()).toBe(true);
    expect(state.store.get(uuid(21))?.element).toMatchObject({ start: { x: 98, y: 99 } });
    second.revert();
    state.cleanup();
  });

  it("does not restart a cancelled query after another commit changes the revision", async () => {
    const input = new AbortController();
    const state = fixture(undefined, input.signal);
    const query = vi.spyOn(state.scene, "beginQuery");
    state.preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
    state.preview.commit();
    input.abort();
    state.history.create([rectangle(uuid(21), 500, 500)]);
    const visits = query.mock.calls.length;
    state.resume();
    expect(await state.preview.completion).toBe(false);
    expect(query.mock.calls.length).toBe(visits);
    expect(state.store.get(uuid(20))?.element).toMatchObject({ end: { x: 98, y: 99 } });
    expect(state.history.undo()).toBe(true);
    expect(state.store.get(uuid(20))).toBeDefined();
    state.cleanup();
  });
});

describe("refinement signal cleanup", () => {
  it.each([false, true])(
    "releases its listener for initially aborted=%s input",
    async (aborted) => {
      const input = new AbortController();
      if (aborted) input.abort();
      const add = vi.spyOn(input.signal, "addEventListener");
      const remove = vi.spyOn(input.signal, "removeEventListener");
      const state = fixture(undefined, input.signal);
      state.preview.update({ pointerId: 1, pointerType: "mouse", x: 98, y: 99 });
      expect(state.preview.commit()).toBe(true);
      expect(state.store.get(uuid(20))).toBeDefined();
      expect(input.signal.aborted).toBe(aborted);
      state.resume();
      expect(await state.preview.completion).toBe(!aborted);
      expect(add).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]![1]);
      expect(state.releaseOperation).toHaveBeenCalledOnce();
      state.cleanup();
    },
  );
});
