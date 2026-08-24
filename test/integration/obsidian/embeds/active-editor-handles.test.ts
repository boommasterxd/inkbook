import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type { InkElementV1, PageV1, PointV1 } from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../src/domain/store/public";
import { createDragElement } from "../../../../src/editor/tools/public";
import { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { MovePreview } from "../../../../src/obsidian/embeds/active-editor/selection-preview";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { elementMutationPorts } from "../../../fixtures/obsidian/element-mutation-ports";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
};

function rectangle(): Extract<InkElementV1, { kind: "rectangle" }> {
  const element = createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 300, y: 240 },
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    start: { x: 100, y: 100 },
    tool: "rectangle",
  });
  if (element.kind !== "rectangle") throw new TypeError("Expected a rectangle fixture.");
  return element;
}

function line(): Extract<InkElementV1, { kind: "line" }> {
  const element = createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 50, y: 50 },
    identity: { createdAt: 2, id: "00000000-0000-4000-8000-000000000002" },
    start: { x: 10, y: 10 },
    tool: "line",
  });
  if (element.kind !== "line") throw new TypeError("Expected a line fixture.");
  return element;
}

function rotatedTable(): Extract<InkElementV1, { kind: "table" }> {
  return {
    columnWidth: 100,
    columns: 2,
    createdAt: 3,
    headerHeight: 24,
    height: 100,
    id: "00000000-0000-4000-8000-000000000004",
    kind: "table",
    pivot: { x: 200, y: 150 },
    rotation: 90,
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    x: 100,
    y: 100,
  };
}

function dependentLine(): Extract<InkElementV1, { kind: "line" }> {
  const element = createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 500, y: 300 },
    identity: { createdAt: 2, id: "00000000-0000-4000-8000-000000000003" },
    start: { x: 300, y: 240 },
    startConnection: {
      anchor: { kind: "box", position: "bottom-right" },
      targetId: startId(),
    },
    tool: "line",
  });
  if (element.kind !== "line") throw new TypeError("Expected a dependent line fixture.");
  return element;
}

function editableModel(store: ElementStore): EditableDocumentModel {
  let revision = 0;
  const create = (elements: readonly InkElementV1[]): void => {
    if (store.create(elements) !== null) revision += 1;
  };
  return {
    mutationAvailability: "available",
    page: PAGE,
    get revision() {
      return revision;
    },
    store,
    ...elementMutationPorts(store, () => {
      revision += 1;
    }),
    arrangeElements: vi.fn(),
    commitBandOrder: (order) => {
      if (store.reorderBands(order) !== null) revision += 1;
    },
    commitElement: (element) => create([element]),
    commitElements: create,
    commitPage: vi.fn(),
    commitPreparedElementReplacement: (token) => {
      const result = store.commitPreparedElementReplacement(token);
      if (result.status === "committed") revision += 1;
      return result.status;
    },
    encodeClipboard: async () => null,
    planClipboardPaste: async () => null,
    prepareElementReplacement: (replacements, cancellation) =>
      store.prepareElementReplacement(replacements, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => false,
        yieldControl: () => Promise.resolve(),
      }),
    removeElements: (ids) => {
      if (store.remove(ids) !== null) revision += 1;
    },
    replaceElements: (elements) => {
      if (store.replaceMany(elements) !== null) revision += 1;
    },
    setGestureActive: vi.fn(),
  };
}

describe("active editor selection handles", () => {
  it("drives a shape handle through preview, store commit, renderer delta, and undo", () => {
    const { deltas, history, interaction, overlays, previewTransforms, store } = harness(
      [rectangle()],
      new Set([startId()]),
    );
    const bounds = calculateElementBounds(rectangle());
    const start = { pointerId: 1, pointerType: "mouse" as const, x: bounds.maxX, y: bounds.maxY };

    interaction.renderSelection();
    expect(interaction.pointerDown(start)).toBe(true);
    expect(interaction.pointerMove({ ...start, x: start.x + 80, y: start.y + 40 })).toBe(true);
    expect(interaction.pointerUp(start.pointerId)).toBe(true);

    const resized = store.get(startId())?.element;
    expect(resized?.kind).toBe("rectangle");
    if (resized?.kind !== "rectangle") throw new TypeError("Expected the resized rectangle.");
    expect(resized.width).toBeGreaterThan(200);
    expect(resized.height).toBeGreaterThan(140);
    expect(deltas).toEqual([[startId()]]);
    expect(overlays.some((path) => path?.includes(" a 5 5 ") === true)).toBe(true);
    expect(previewTransforms[previewTransforms.length - 1]).toBeNull();
    expect(history.undo()).toBe(true);
    expect(store.get(startId())?.element).toMatchObject({ height: 140, width: 200 });
  });

  it("snaps a line endpoint to a semantic anchor and detaches it when moved away", () => {
    const selectedLine = line();
    const { interaction, store } = harness([rectangle(), selectedLine], new Set([selectedLine.id]));
    const start = {
      pointerId: 2,
      pointerType: "mouse" as const,
      x: selectedLine.end.x,
      y: selectedLine.end.y,
    };

    expect(interaction.pointerDown(start)).toBe(true);
    interaction.pointerMove({ ...start, x: 100, y: 100 });
    interaction.pointerUp(start.pointerId);

    const connected = store.get(selectedLine.id)?.element;
    expect(connected?.kind).toBe("line");
    if (connected?.kind !== "line") throw new TypeError("Expected a connected line.");
    expect(connected.endConnection).toEqual({
      anchor: { kind: "box", position: "top-left" },
      targetId: startId(),
    });

    expect(interaction.pointerDown({ ...start, x: connected.end.x, y: connected.end.y })).toBe(
      true,
    );
    interaction.pointerMove({ ...start, x: 500, y: 500 });
    interaction.pointerUp(start.pointerId);
    const detached = store.get(selectedLine.id)?.element;
    expect(detached?.kind === "line" ? detached.endConnection : undefined).toBeNull();
  });

  it("publishes reverse-map dependent endpoint geometry during a shape-handle preview", () => {
    const target = rectangle();
    const dependent = dependentLine();
    const { elementPreviews, interaction } = harness([target, dependent], new Set([target.id]));
    const start = {
      pointerId: 3,
      pointerType: "mouse" as const,
      x: 300,
      y: 240,
    };

    expect(interaction.pointerDown(start)).toBe(true);
    expect(interaction.pointerMove({ ...start, x: 380, y: 280 })).toBe(true);

    expectLatestLinePreview(elementPreviews, dependent.id, { x: 380, y: 280 });

    interaction.cancel(start.pointerId);
    expect(elementPreviews[elementPreviews.length - 1]).toEqual([]);
  });

  it("previews and commits non-uniform scaling in a rotated generic element frame", () => {
    const table = rotatedTable();
    const { interaction, previewTransforms, store } = harness([table], new Set([table.id]));
    const start = { pointerId: 6, pointerType: "mouse" as const, x: 148, y: 252 };

    expect(interaction.pointerDown(start)).toBe(true);
    expect(interaction.pointerMove({ ...start, x: 44, y: 354 })).toBe(true);
    expect(previewTransforms[previewTransforms.length - 1]).toBe(
      "translate(252 48) rotate(90) scale(1.5 2) rotate(-90) translate(-252 -48)",
    );
    expect(interaction.pointerUp(start.pointerId)).toBe(true);

    expect(store.get(table.id)?.element).toMatchObject({
      columnWidth: 150,
      headerHeight: 48,
      height: 200,
      pivot: { x: 251, y: 202 },
      rotation: 90,
      x: 101,
      y: 102,
    });
  });
});

describe("active editor ordinary selection move", () => {
  it("publishes unselected connected endpoints through the reverse map", () => {
    const target = rectangle();
    const dependent = dependentLine();
    const selection = new Set([target.id]);
    const fixture = harness([target, dependent], selection);
    const preview = movePreview(fixture, selection, {
      pointerId: 4,
      pointerType: "mouse",
      x: 300,
      y: 240,
    });
    fixture.store.resetInstrumentation();

    preview.update({ pointerId: 4, pointerType: "mouse", x: 340, y: 270 });

    expectLatestLinePreview(fixture.elementPreviews, dependent.id, { x: 340, y: 270 });
    expect(fixture.store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 1,
    });
    preview.revert();
    expect(fixture.elementPreviews[fixture.elementPreviews.length - 1]).toEqual([]);
  });

  it("commits exact outside-viewport geometry without changing selection relationships", () => {
    const first = rectangle();
    const second = {
      ...rectangle(),
      createdAt: 4,
      id: "00000000-0000-4000-8000-000000000004",
      pivot: { x: 600, y: 420 },
      x: 500,
      y: 350,
    };
    const selection = new Set([first.id, second.id]);
    const fixture = harness([first, second], selection);
    const preview = movePreview(fixture, selection, {
      pointerId: 5,
      pointerType: "mouse",
      x: 0,
      y: 0,
    });

    preview.update({ pointerId: 5, pointerType: "mouse", x: -700, y: -600 });
    expect(preview.commit()).toBe(true);

    const movedFirst = fixture.store.get(first.id)?.element;
    const movedSecond = fixture.store.get(second.id)?.element;
    expect(movedFirst?.kind).toBe("rectangle");
    expect(movedSecond?.kind).toBe("rectangle");
    if (movedFirst?.kind !== "rectangle" || movedSecond?.kind !== "rectangle") {
      throw new TypeError("Expected rectangle replacements.");
    }
    expect(calculateElementBounds(movedFirst)).toMatchObject({ minX: -602, minY: -502 });
    expect({ x: movedSecond.x - movedFirst.x, y: movedSecond.y - movedFirst.y }).toEqual({
      x: 400,
      y: 250,
    });
    expect(fixture.history.commandCount).toBe(1);
    expect(fixture.history.undo()).toBe(true);
    expect(fixture.store.get(first.id)?.element).toMatchObject({ x: 100, y: 100 });
    expect(fixture.store.get(second.id)?.element).toMatchObject({ x: 500, y: 350 });
  });
});

describe("active editor large selection handles", () => {
  it("prepares a large mixed move in slices and keeps async undo and redo atomic", async () => {
    const shape = rectangle();
    const strokes = Array.from({ length: 1_000 }, (_, index) => indexedStroke(index));
    const elements = [shape, ...strokes];
    const store = new ElementStore(elements);
    const model = editableModel(store);
    const history = new ActiveEditorHistory(model);
    let finishPending = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
      finishPending = resolve;
    });
    const preparedHistory = new PreparedElementHistory({
      history,
      isAttached: () => true,
      model,
      motion: previewCommitMotion(),
      onPendingChanged: (pending) => {
        if (!pending) finishPending();
      },
      ownerWindow: frameWindow(),
    });
    const preview = new MovePreview({
      history,
      pageToScreen: (point) => point,
      preparedHistory,
      renderer: {
        clearElementPreviews: vi.fn(),
        clearPreviewTransforms: vi.fn(),
        setElementPreviews: vi.fn(),
        setOverlayPath: vi.fn(),
        setPreviewTransform: vi.fn(),
        suppressMotionForNextDelta: vi.fn(),
      },
      sceneStore: new ElementSceneStore(store),
      selection: () => new Set(elements.map(({ id }) => id)),
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: { pointerId: 9, pointerType: "mouse", x: 0, y: 0 },
        tool: "select",
      },
      store,
    });

    preview.update({ pointerId: 9, pointerType: "mouse", x: 25, y: 40 });
    expect(preview.commit()).toBe(true);
    await finished;
    expect(store.get(strokes[0]!.id)?.element.pivot).toEqual({ x: 45, y: 60 });
    expect(store.get(shape.id)?.element.pivot).toEqual({ x: 225, y: 210 });
    expect(history.commandCount).toBe(1);
    await expect(history.undoAsync()).resolves.toBe(true);
    expect(store.get(strokes[0]!.id)?.element.pivot).toEqual({ x: 20, y: 20 });
    expect(store.get(shape.id)?.element.pivot).toEqual({ x: 200, y: 170 });
    await expect(history.redoAsync()).resolves.toBe(true);
    expect(store.get(strokes[0]!.id)?.element.pivot).toEqual({ x: 45, y: 60 });
    preparedHistory.dispose();
  });
});

function harness(elements: readonly InkElementV1[], selection: ReadonlySet<string>) {
  const store = new ElementStore(elements);
  const model = editableModel(store);
  const history = new ActiveEditorHistory(model);
  const sceneStore = new ElementSceneStore(store);
  const overlays: Array<string | null> = [];
  const previewTransforms: Array<string | null> = [];
  const elementPreviews: InkElementV1[][] = [];
  const deltas: string[][] = [];
  store.subscribe((delta) => deltas.push(delta.changes.map(({ id }) => id)));
  const preparedHistory = new PreparedElementHistory({
    history,
    isAttached: () => true,
    model,
    motion: previewCommitMotion(),
    onPendingChanged: vi.fn(),
    ownerWindow: frameWindow(),
  });
  const renderer = {
    clearElementPreviews: () => elementPreviews.push([]),
    clearPreviewTransforms: () => previewTransforms.push(null),
    setElementPreviews: (elements: readonly InkElementV1[]) => elementPreviews.push([...elements]),
    setOverlayPath: vi.fn(),
    setSelectionOverlayPath: (path: string | null) => overlays.push(path),
    setSnapMarkerPath: (path: string | null) => overlays.push(path),
    setPreviewTransform: (_ids: readonly string[], transform: string | null) =>
      previewTransforms.push(transform),
    suppressMotionForNextDelta: vi.fn(),
  };
  const interaction = new ActiveEditorHandleInteraction({
    history,
    model,
    pageToScreen: (point) => point,
    preparedHistory,
    renderer,
    sceneStore,
    selection: () => selection,
    zoom: () => 1,
  });
  return {
    deltas,
    elementPreviews,
    history,
    interaction,
    model,
    overlays,
    preparedHistory,
    previewTransforms,
    renderer,
    sceneStore,
    store,
  };
}

function expectLatestLinePreview(
  previews: readonly (readonly InkElementV1[])[],
  id: string,
  expectedStart: PointV1,
): void {
  const current = previews[previews.length - 1] ?? [];
  const dependent = current.find((element) => element.id === id);
  expect(dependent?.kind).toBe("line");
  if (dependent?.kind !== "line") throw new TypeError("Expected a line preview.");
  expect(dependent.start).toEqual(expectedStart);
}

function movePreview(
  fixture: ReturnType<typeof harness>,
  selection: ReadonlySet<string>,
  pointer: PointV1 & { readonly pointerId: number; readonly pointerType: "mouse" },
): MovePreview {
  return new MovePreview({
    history: fixture.history,
    pageToScreen: (point) => point,
    preparedHistory: fixture.preparedHistory,
    renderer: fixture.renderer,
    sceneStore: fixture.sceneStore,
    selection: () => selection,
    setSelection: vi.fn(),
    start: { additive: false, kind: "element-move", pointer, tool: "select" },
    store: fixture.store,
  });
}

function frameWindow(): Window {
  let frame = 0;
  return {
    cancelAnimationFrame: vi.fn(),
    performance,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const next = ++frame;
      queueMicrotask(() => callback(performance.now()));
      return next;
    },
  } as unknown as Window;
}

function previewCommitMotion() {
  return {
    beginPreviewCommit: vi.fn(() => ({
      arm: vi.fn(() => true),
      cancel: vi.fn(),
    })),
  };
}

function startId(): string {
  return "00000000-0000-4000-8000-000000000001";
}
