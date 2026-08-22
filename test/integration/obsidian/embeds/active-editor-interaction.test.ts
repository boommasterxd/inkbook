import { describe, expect, it, vi } from "vitest";

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
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { encodeSelection } from "../../../../src/persistence/clipboard/public";
import { createDragElement } from "../../../../src/editor/tools/public";
import { elementMutationPorts } from "../../../fixtures/obsidian/element-mutation-ports";
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
      writingLineHeight: 100,
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
      const encoded = encodeSelection(elements, selectedIds);
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
      activateTemporaryEraser: vi.fn(),
      beginPinch: vi.fn(),
      beginPreview: (start) =>
        new CreationPreview({
          defaults: createBuiltInSettings().toolDefaults,
          history,
          identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
          renderer: creationPreviewRenderer({
            clearLiveStroke: () => livePaths.push(null),
            revertLiveStroke: () => livePaths.push(null),
            setLivePath: (path) => livePaths.push(path?.parts.map(({ d }) => d).join(" ") ?? null),
            updateLiveStroke: (preview) => livePaths.push(preview.tail.geometry.d),
          }),
          start,
        }),
      cancelLongPress: vi.fn(),
      capturePointer: vi.fn(),
      clearSelection: vi.fn(),
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

describe("active editor eraser composition", () => {
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
    const options = {
      history,
      model: document,
      ownerWindow: {
        cancelAnimationFrame: vi.fn(),
        performance,
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          queueMicrotask(() => callback(performance.now()));
          return 1;
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
    expect(fades).toEqual([{ durationMs: 160, ids: [element.id] }]);
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
    expect(overlays[overlays.length - 1]).toContain("M 192.5 200");
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

describe("active editor creation minimums", () => {
  it("rejects a second connection that would violate the linear minimum length", () => {
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
    expect(arrow.endConnection).toBeNull();
    expect(
      Math.hypot(arrow.end.x - arrow.start.x, arrow.end.y - arrow.start.y),
    ).toBeGreaterThanOrEqual(8);
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
