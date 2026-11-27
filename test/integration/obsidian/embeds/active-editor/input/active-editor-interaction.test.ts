import { createSelectionPreviewRenderer } from "../../../../../fixtures/obsidian/selection-preview-renderer";
import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { GestureController } from "../../../../../../src/editor/gestures/public";
import { createInputState, reduceInput } from "../../../../../../src/editor/input/index";
import { EraserPreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/eraser-preview";
import { ActiveEditorHistory } from "../../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { CreationPreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import { LassoPreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/selection-preview";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/vault-document-session";
import { encodeRuntimeSelection } from "../../../../../../src/persistence/clipboard/codec";
import { createDragElement } from "../../../../../../src/editor/tools/public";
import { creationPreviewRenderer } from "../../../../../fixtures/obsidian/active-editor";
import { elementMutationPorts } from "../../../../../fixtures/obsidian/element-mutation-ports";
import { ManualFrameScheduler } from "../../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../../fixtures/obsidian/work-scheduler";

function model(): EditableDocumentModel {
  const store = new ElementStore();
  let revision = 0;
  const document: EditableDocumentModel = {
    mutationAvailability: "available",
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    get revision() {
      return revision;
    },
    store,
    ...elementMutationPorts(store, () => {
      revision += 1;
    }),
    arrangeElements: (ids, action) => {
      if (store.arrange(ids, action) !== null) revision += 1;
    },
    commitBandOrder: (order) => {
      if (store.reorderBands(order) !== null) revision += 1;
    },
    commitElement: (element) => {
      if (store.create(element) !== null) revision += 1;
    },
    commitElements: (elements) => {
      if (store.create(elements) !== null) revision += 1;
    },
    commitPage: vi.fn(() => {
      revision += 1;
    }),
    encodeClipboard: async (selectedIds) => {
      const elements = store.materializeSnapshot({ page: document.page, revision }).elements;
      const encoded = encodeRuntimeSelection(elements, selectedIds);
      return encoded.ok ? encoded.value : null;
    },
    planClipboardPaste: async () => null,
    removeElements: (ids) => {
      if (store.remove(ids) !== null) revision += 1;
    },
    replaceElements: (elements) => {
      if (store.replaceMany(elements) !== null) revision += 1;
    },
    prepareElementReplacement: (replacements, cancellation) =>
      store.prepareElementReplacement(replacements, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => false,
        yieldControl: () => Promise.resolve(),
      }),
    commitPreparedElementReplacement: (token) => {
      const result = store.commitPreparedElementReplacement(token);
      if (result.status === "committed") revision += 1;
      return result.status;
    },
    setGestureActive: vi.fn(),
  };
  return document;
}

it("commits the dragged rectangle as one reversible edit", () => {
  const document = model();
  const history = new ActiveEditorHistory(document);
  const identity = { createdAt: 1, id: "00000000-0000-4000-8000-000000000021" };
  const pointer = { pointerId: 9, pointerType: "mouse" as const, x: 100, y: 100 };
  const preview = new CreationPreview({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    identity,
    renderer: creationPreviewRenderer(),
    start: { additive: false, kind: "tool-gesture", pointer, tool: "rectangle" },
  });

  preview.update({ ...pointer, x: 280, y: 240 });
  expect(preview.commit()).toBe(true);
  const rectangle = document.store.get(identity.id)?.element;
  expect(rectangle).toMatchObject({ kind: "rectangle", x: 100, y: 100, width: 180, height: 140 });
  expect(history.commandCount).toBe(1);
  expect(history.undo()).toBe(true);
  expect(document.store.size).toBe(0);
  expect(history.redo()).toBe(true);
  expect(document.store.get(identity.id)?.element).toEqual(rectangle);
  history.dispose();
});

describe("active editor selection area composition", () => {
  it.each([
    { createsArea: true, pointerType: "mouse" },
    { createsArea: true, pointerType: "pen" },
    { createsArea: false, pointerType: "touch" },
  ] as const)(
    "routes a complete $pointerType Select drag by pointer ownership",
    ({ createsArea, pointerType }) => {
      const document = model();
      const target = createDragElement({
        defaults: createBuiltInSettings().toolDefaults,
        end: { x: 300, y: 240 },
        identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000021" },
        start: { x: 100, y: 100 },
        tool: "rectangle",
      });
      document.commitElement(target);
      const sceneStore = new ElementSceneStore(document.store);
      let selection: ReadonlySet<string> = new Set();
      const controller = new GestureController({
        ...passiveGesturePorts(),
        beginPreview: (start) =>
          new LassoPreview({
            workScheduler: workSchedulerFromFrames(new ManualFrameScheduler()),
            history: new ActiveEditorHistory(document),
            pageToScreen: (point) => point,
            preparedHistory: {} as PreparedElementHistory,
            renderer: createSelectionPreviewRenderer(),
            sceneStore,
            selection: () => selection,
            selectionDefaults: { area: "lasso", inclusion: "fully-enclosed" },
            setSelection: (next) => {
              selection = next;
            },
            start,
            store: document.store,
          }),
        clearSelection: () => {
          selection = new Set();
        },
      });
      let state = createInputState({ activeTool: "select" });
      const points = [
        { x: 50, y: 50 },
        { x: 350, y: 50 },
        { x: 350, y: 300 },
        { x: 50, y: 300 },
      ];
      const down = points[0]!;
      const actions = [
        {
          ...down,
          button: 0,
          buttons: 1,
          controlOrMeta: false,
          isPlatformContextClick: false,
          pointerId: 9,
          pointerType,
          pressure: 0.5,
          shift: false,
          type: "pointer-down" as const,
        },
        ...points.slice(1).map((point) => ({
          ...point,
          pointerId: 9,
          pointerType,
          pressure: 0.5,
          type: "pointer-move" as const,
        })),
        { pointerId: 9, type: "pointer-up" as const },
      ];
      for (const action of actions) {
        const reduction = reduceInput(state, action);
        state = reduction.state;
        controller.apply(reduction);
      }

      expect(selection).toEqual(createsArea ? new Set([target.id]) : new Set());
      sceneStore.release();
    },
  );
});

function passiveGesturePorts() {
  return {
    activateTemporaryEraser: vi.fn(),
    beginPinch: vi.fn(),
    cancelLongPress: vi.fn(),
    capturePointer: vi.fn(),
    finishPinch: vi.fn(),
    openContextMenu: vi.fn(),
    panPage: vi.fn(),
    releasePointer: vi.fn(),
    restoreTemporaryTool: vi.fn(),
    revertNavigation: vi.fn(),
    revertPinch: vi.fn(),
    scheduleLongPress: vi.fn(),
    scrollNote: vi.fn(),
    selectElement: vi.fn(),
    updatePinch: vi.fn(),
  };
}

describe("active editor eraser commit", () => {
  it("retains eraser Undo after presentation release and cancels replay on session shutdown", async () => {
    const document = model();
    const element = createDragElement({
      defaults: createBuiltInSettings().toolDefaults,
      end: { x: 200, y: 200 },
      identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000002" },
      start: { x: 100, y: 100 },
      tool: "rectangle",
    });
    document.commitElement(element);
    const history = new ActiveEditorHistory(document);
    const fades: Array<{ durationMs: number; ids: readonly string[] }> = [];
    const cleared: string[][] = [];
    const pendingFrames = new Set<number>();
    let nextFrame = 0;
    const options = {
      history,
      model: document,
      workScheduler: workSchedulerFromFrames({
        cancelAnimationFrame: (handle: number) => pendingFrames.delete(handle),
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          const handle = ++nextFrame;
          pendingFrames.add(handle);
          queueMicrotask(() => {
            if (pendingFrames.delete(handle)) callback(performance.now());
          });
          return handle;
        },
      }),
      radius: 20,
      renderer: {
        clearElementFade: (ids: readonly string[]) => cleared.push([...ids]),
        setElementFade: (ids: readonly string[], durationMs: number) =>
          fades.push({ durationMs, ids: [...ids] }),
      },
      sceneStore: new ElementSceneStore(document.store),
      start: {
        additive: false,
        kind: "eraser-gesture" as const,
        pointer: { pointerId: 5, pointerType: "pen" as const, x: 100, y: 150 },
        tool: "eraser" as const,
      },
    };
    const cancelled = new EraserPreview(options);
    expect(fades).toEqual([{ durationMs: 150, ids: [element.id] }]);
    cancelled.revert();
    expect(cleared).toContainEqual([element.id]);
    expect(document.store.size).toBe(1);

    const committed = new EraserPreview(options);
    committed.update({ pointerId: 5, pointerType: "pen", x: 200, y: 150 });
    expect(committed.commit()).toBe(true);
    await expect(committed.completion).resolves.toBe(true);
    expect(document.store.size).toBe(0);
    expect(history.commandCount).toBe(1);
    options.sceneStore.release();
    options.workScheduler.dispose();
    await expect(history.undoAsync()).resolves.toBe(true);
    expect(document.store.get(element.id)?.element).toEqual(element);
    await expect(history.redoAsync()).resolves.toBe(true);
    expect(document.store.size).toBe(0);

    const prepare = document.prepareElementMutation.bind(document);
    vi.spyOn(document, "prepareElementMutation").mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      history.dispose();
      return prepared;
    });
    await expect(history.undoAsync()).resolves.toBe(false);
    expect(document.store.size).toBe(0);
    expect(pendingFrames.size).toBe(0);
  });
});
