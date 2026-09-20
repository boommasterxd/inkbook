import { describe, expect, it, vi } from "vitest";
import { selectedRectangle } from "./active-editor-clipboard-fixtures";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../src/domain/store/public";
import { GestureController } from "../../../../src/editor/gestures/public";
import { createInputState, reduceInput } from "../../../../src/editor/input/index";
import {
  CreationPreview,
  type CreationSnapPorts,
} from "../../../../src/obsidian/embeds/active-editor/creation-preview";
import { EraserPreview } from "../../../../src/obsidian/embeds/active-editor/eraser-preview";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { LassoPreview } from "../../../../src/obsidian/embeds/active-editor/selection-preview";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { encodeRuntimeSelection } from "../../../../src/persistence/clipboard/codec";
import { createDragElement } from "../../../../src/editor/tools/public";
import { elementMutationPorts } from "../../../fixtures/obsidian/element-mutation-ports";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";
import { creationPreviewRenderer } from "../../../fixtures/obsidian/active-editor";

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

describe("active editor interaction composition", () => {
  it("reduces pen input through a gesture preview into store and renderer updates", () => {
    const document = model();
    const history = new ActiveEditorHistory(document);
    const livePaths: Array<string | null> = [];
    const renderedDeltas: string[][] = [];
    document.store.subscribe((delta) => renderedDeltas.push(delta.changes.map(({ id }) => id)));
    const controller = new GestureController({
      ...passiveGesturePorts(),
      beginPreview: (start) =>
        new CreationPreview({
          defaults: createBuiltInSettings().toolDefaults,
          history,
          identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
          renderer: creationPreviewRenderer({
            clearLiveStroke: () => livePaths.push(null),
            commitLiveStroke: () => livePaths.push(null),
            setLivePath: (path) => livePaths.push(path?.parts.map(({ d }) => d).join(" ") ?? null),
            updateLiveStroke: (preview) =>
              livePaths.push(preview.tail.geometry.map(({ d }) => d).join(" ")),
          }),
          start,
        }),
      clearSelection: vi.fn(),
    });
    let state = createInputState({ activeTool: "draw" });
    for (const action of [
      {
        type: "pointer-down" as const,
        pointerId: 7,
        pointerType: "pen" as const,
        x: 10,
        y: 20,
        pressure: 0.4,
        button: 0,
        buttons: 1,
        controlOrMeta: false,
        isPlatformContextClick: false,
        shift: false,
      },
      { type: "pointer-move" as const, pointerId: 7, pointerType: "pen" as const, x: 30, y: 40 },
      { type: "pointer-up" as const, pointerId: 7 },
    ]) {
      const reduction = reduceInput(state, action);
      state = reduction.state;
      controller.apply(reduction);
    }

    expect(document.store.size).toBe(1);
    expect(renderedDeltas).toEqual([["00000000-0000-4000-8000-000000000001"]]);
    expect(livePaths[livePaths.length - 1]).toBeNull();
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toBe(true);
    expect(document.store.size).toBe(0);
    expect(history.redo()).toBe(true);
    expect(document.store.size).toBe(1);
  });
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
            history: new ActiveEditorHistory(document),
            pageToScreen: (point) => point,
            preparedHistory: {} as PreparedElementHistory,
            renderer: {
              clearPreviewTransforms: vi.fn(),
              setOverlayPath: vi.fn(),
              setPreviewTransform: vi.fn(),
              suppressMotionForNextDelta: vi.fn(),
            },
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

describe("active editor eraser composition", () => {
  it.each(["revert", "revision"])(
    "continues stationary queries on owned frames and cancels on %s",
    (reason) => {
      const document = model();
      const base = selectedRectangle();
      const elements = Array.from({ length: 2_000 }, (_, index) => ({
        ...base,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }));
      document.commitElements(elements);
      const frames = new ManualFrameScheduler();
      const faded = new Set<string>();
      const sceneStore = new ElementSceneStore(document.store);
      const preview = new EraserPreview({
        history: new ActiveEditorHistory(document),
        model: document,
        radius: 20,
        ownerWindow: {
          requestAnimationFrame: (callback: FrameRequestCallback) =>
            frames.requestAnimationFrame(callback),
          cancelAnimationFrame: (handle: number) => frames.cancelAnimationFrame(handle),
          performance,
        } as unknown as Window,
        renderer: {
          clearElementFade: (ids) => ids.forEach((id) => faded.delete(id)),
          setElementFade: (ids) => ids.forEach((id) => faded.add(id)),
        },
        sceneStore,
        sliceBudgetMs: () => 0,
        start: {
          additive: false,
          kind: "eraser-gesture",
          tool: "eraser",
          pointer: { pointerId: 5, pointerType: "pen", x: 100, y: 150 },
        },
      });
      const initial = faded.size;
      expect(initial).toBeGreaterThan(0);
      expect(initial).toBeLessThan(elements.length);
      expect(frames.pendingCount).toBe(1);
      frames.runNext();
      expect(faded.size).toBeGreaterThan(initial);
      expect(document.store.size).toBe(elements.length);
      expect(frames.pendingCount).toBe(1);
      if (reason === "revision") {
        document.commitPage(document.page);
        frames.runNext();
      } else preview.revert();
      expect(frames.pendingCount).toBe(0);
      expect(faded.size).toBe(0);
      expect(document.store.size).toBe(elements.length);
      sceneStore.release();
    },
  );
});

describe("active editor eraser commit", () => {
  it("previews, cancels, and atomically removes complete eraser hits with undo", async () => {
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
      ownerWindow: {
        cancelAnimationFrame: (handle: number) => pendingFrames.delete(handle),
        performance,
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          const handle = ++nextFrame;
          pendingFrames.add(handle);
          queueMicrotask(() => {
            if (pendingFrames.delete(handle)) callback(performance.now());
          });
          return handle;
        },
      } as unknown as Window,
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
    expect(fades).toEqual([{ durationMs: 300, ids: [element.id] }]);
    cancelled.revert();
    expect(cleared).toContainEqual([element.id]);
    expect(document.store.size).toBe(1);

    const committed = new EraserPreview(options);
    committed.update({ pointerId: 5, pointerType: "pen", x: 200, y: 150 });
    expect(committed.commit()).toBe(true);
    await expect(committed.completion).resolves.toBe(true);
    expect(document.store.size).toBe(0);
    expect(history.commandCount).toBe(1);
    await expect(history.undoAsync()).resolves.toBe(true);
    expect(document.store.size).toBe(1);
  });
});

describe("active editor creation snapping", () => {
  it("persists semantic endpoint connections and keeps snap markers screen-sized", () => {
    const document = model();
    const first = createDragElement({
      defaults: createBuiltInSettings().toolDefaults,
      end: { x: 200, y: 200 },
      identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000011" },
      start: { x: 100, y: 100 },
      tool: "rectangle",
    });
    const second = createDragElement({
      defaults: createBuiltInSettings().toolDefaults,
      end: { x: 500, y: 200 },
      identity: { createdAt: 2, id: "00000000-0000-4000-8000-000000000012" },
      start: { x: 400, y: 100 },
      tool: "rectangle",
    });
    document.commitElements([first, second]);
    const sceneStore = new ElementSceneStore(document.store);
    const overlays: Array<string | null> = [];
    const preview = new CreationPreview({
      defaults: createBuiltInSettings().toolDefaults,
      history: new ActiveEditorHistory(document),
      identity: { createdAt: 3, id: "00000000-0000-4000-8000-000000000013" },
      renderer: creationPreviewRenderer({ setSnapMarkerPath: (path) => overlays.push(path) }),
      snap: rectangleSnap(sceneStore, ({ x, y }) => ({ x: x * 2, y: y * 2 }), 2),
      start: {
        additive: false,
        kind: "tool-gesture",
        pointer: { pointerId: 1, pointerType: "mouse", x: 103, y: 102 },
        tool: "line",
      },
    });

    preview.update({ pointerId: 1, pointerType: "mouse", x: 397, y: 102 });
    expect(overlays[overlays.length - 1]).toContain("M 188 200 L 212 200");
    expect(overlays[overlays.length - 1]).not.toContain("Z");
    expect(preview.commit()).toBe(true);
    const line = document.store.get("00000000-0000-4000-8000-000000000013")?.element;
    expect(line?.kind).toBe("line");
    if (line?.kind !== "line") throw new TypeError("Expected a connected line.");
    expect(line.startConnection).toEqual({
      anchor: { kind: "box", position: "top-left" },
      targetId: first.id,
    });
    expect(line.endConnection).toEqual({
      anchor: { kind: "box", position: "top-left" },
      targetId: second.id,
    });
    expect(overlays[overlays.length - 1]).toBeNull();
  });
});

describe("active editor collapsed creation", () => {
  it("commits coincident connected endpoints without extending the arrow", () => {
    const document = model();
    const target = createDragElement({
      defaults: createBuiltInSettings().toolDefaults,
      end: { x: 200, y: 200 },
      identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000031" },
      start: { x: 100, y: 100 },
      tool: "rectangle",
    });
    document.commitElement(target);
    const sceneStore = new ElementSceneStore(document.store);
    const preview = new CreationPreview({
      defaults: createBuiltInSettings().toolDefaults,
      history: new ActiveEditorHistory(document),
      identity: { createdAt: 2, id: "00000000-0000-4000-8000-000000000032" },
      renderer: creationPreviewRenderer(),
      snap: rectangleSnap(sceneStore, (point) => point, 1),
      start: {
        additive: false,
        kind: "tool-gesture",
        pointer: { pointerId: 1, pointerType: "mouse", x: 101, y: 101 },
        tool: "arrow",
      },
    });

    expect(preview.commit()).toBe(true);
    const arrow = document.store.get("00000000-0000-4000-8000-000000000032")?.element;
    expect(arrow?.kind).toBe("arrow");
    if (arrow?.kind !== "arrow") throw new TypeError("Expected an arrow.");
    expect(arrow.startConnection?.targetId).toBe(target.id);
    expect(arrow.endConnection).toEqual(arrow.startConnection);
    expect(arrow.end).toEqual(arrow.start);
  });
});

function rectangleSnap(
  sceneStore: ElementSceneStore,
  pageToScreen: CreationSnapPorts["pageToScreen"],
  zoom: number,
): CreationSnapPorts {
  return {
    pageToScreen,
    spatial: { query: (bounds, sink) => sceneStore.query(bounds, sink) },
    targets: {
      get: (id) => sceneStore.getSnapTarget(id),
    },
    zoom,
  };
}
