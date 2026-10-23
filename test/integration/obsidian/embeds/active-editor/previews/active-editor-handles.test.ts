import { describe, expect, it, vi } from "vitest";

import * as geometry from "../../../../../../src/domain/geometry/public";
import type { InkElementV1, PageV1, PointV1 } from "../../../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { createDragElement } from "../../../../../../src/editor/tools/public";
import { layoutSelectionHandles } from "../../../../../../src/editor/selection/handles";
import { oppositeElementHandlePoint } from "../../../../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import type { HandleInteractionRenderer } from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-presentation";
import { ActiveEditorHistory } from "../../../../../../src/obsidian/embeds/active-editor/history";
import { PreparedElementHistory } from "../../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import { MovePreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/selection-preview";
import type { EditableDocumentModel } from "../../../../../../src/obsidian/embeds/document-session/vault-document-session";
import { indexedStroke } from "../../../../../fixtures/editor/stroke";
import { elementMutationPorts } from "../../../../../fixtures/obsidian/element-mutation-ports";
import { immediateFrameScheduler } from "../../../../../fixtures/obsidian/immediate-frame-scheduler";
import { expectLatestLinePreview } from "../../../../../fixtures/obsidian/selection-preview-assertions";
import { workSchedulerFromFrames } from "../../../../../fixtures/obsidian/work-scheduler";
import { table as geometryTable } from "../../../../../unit/domain/geometry/fixtures";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
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

function rotatedTable(): Extract<InkElementV1, { kind: "table" }> {
  return geometryTable({
    columnWidth: 100,
    columns: 2,
    headerHeight: 24,
    height: 100,
    id: "00000000-0000-4000-8000-000000000004",
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
  });
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
  it("commits fractional shape-handle frames once and restores the box with undo", () => {
    const shape = rectangle();
    const fixture = harness([shape], new Set([shape.id]));
    const { deltas, history, interaction, overlays, previewTransforms, store } = fixture;
    const bounds = geometry.calculateElementBounds(shape);
    const start = { pointerId: 1, pointerType: "touch" as const, x: bounds.maxX, y: bounds.maxY };

    expect(interaction.pointerDown(start)).toBe(true);
    expect(interaction.pointerMove({ ...start, x: start.x + 40.125, y: start.y + 20.25 })).toBe(
      true,
    );
    expect(interaction.pointerMove({ ...start, x: start.x + 80.375, y: start.y + 40.5 })).toBe(
      true,
    );
    expect(previewTransforms).toHaveLength(2);
    expect(previewTransforms.every((transform) => transform !== null)).toBe(true);
    const previewOverlay = overlays[overlays.length - 2];
    expect(store.get(shape.id)?.element).toEqual(shape);
    expect(interaction.pointerUp(start.pointerId)).toBe(true);
    expect(overlays[overlays.length - 2]).toBe(previewOverlay);
    expect(deltas).toEqual([[shape.id]]);
    expect(history.commandCount).toBe(1);
    const resized = store.get(shape.id)?.element;
    if (resized?.kind !== "rectangle") throw new TypeError("Expected the resized rectangle.");
    expect(resized.pivot).toEqual(
      geometry.canonicalPoint({
        x: resized.x + resized.width / 2,
        y: resized.y + resized.height / 2,
      }),
    );
    expect(history.undo()).toBe(true);
    expect(store.get(shape.id)?.element).toEqual(shape);
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
});

describe("active editor generic selection transforms", () => {
  it("previews and commits non-uniform scaling in a rotated generic element frame", () => {
    const table = rotatedTable();
    const { interaction, overlays, store } = harness([table], new Set([table.id]));
    const start = { pointerId: 6, pointerType: "mouse" as const, x: 148, y: 252 };

    expect(interaction.pointerDown(start)).toBe(true);
    expect(interaction.pointerMove({ ...start, x: 44, y: 354 })).toBe(true);
    const previewOverlay = overlays[overlays.length - 2];
    expect(interaction.pointerUp(start.pointerId)).toBe(true);
    expect(overlays[overlays.length - 2]).toBe(previewOverlay);

    const resized = store.get(table.id)?.element;
    if (resized === undefined) throw new TypeError("Expected the resized table.");
    const bounds = store.get(table.id)!.bounds;
    expect(bounds.minX).toBeCloseTo(44, 3);
    expect(bounds.minY).toBeCloseTo(48, 3);
    expect(bounds.maxX).toBeCloseTo(252, 3);
    expect(bounds.maxY).toBeCloseTo(354, 3);
    expect(resized.rotation).toBe(table.rotation);
    expect(resized.style).toEqual(table.style);
  });

  it("commits a rotated freehand resize within one coordinate quantum of its affine preview", () => {
    const stroke: Extract<InkElementV1, { kind: "stroke" }> = {
      ...indexedStroke(20),
      pivot: { x: 160, y: 130 },
      points: [100, 100, 0.5, 160, 130, 0.7, 220, 160, 0.5],
      rotation: 37,
      style: { ...indexedStroke(20).style, width: 8 },
    };
    const selected = [{ bounds: geometry.calculateElementBounds(stroke), element: stroke }];
    const handle = layoutSelectionHandles(selected, { zoom: 1 }).find(
      (candidate) => candidate.kind === "scale" && candidate.position === "bottom-right",
    );
    if (handle?.kind !== "scale") throw new TypeError("Expected a freehand scale handle.");
    const anchor = oppositeElementHandlePoint(stroke, handle.position);
    const current = {
      x: anchor.x + (handle.point.x - anchor.x) * 1.5,
      y: anchor.y + (handle.point.y - anchor.y) * 1.5,
    };
    const { elementPreviews, interaction, renderer, store } = harness(
      [stroke],
      new Set([stroke.id]),
    );
    const start = { ...handle.point, pointerId: 10, pointerType: "mouse" as const };
    expect(interaction.pointerDown(start)).toBe(true);
    expect(interaction.pointerMove({ ...start, ...current })).toBe(true);
    expect(elementPreviews.flat().some(({ id }) => id === stroke.id)).toBe(false);
    const previewStroke = renderer.setProgressiveElementPreviews.mock.lastCall?.[1](stroke.id);
    if (previewStroke?.kind !== "stroke") throw new TypeError("Expected a stroke preview.");
    expect(store.get(stroke.id)?.element.pivot).toEqual(stroke.pivot);
    expect(interaction.pointerUp(start.pointerId)).toBe(true);
    const committedPivot = store.get(stroke.id)?.element.pivot;
    expect(committedPivot).toEqual({ x: 174.932, y: 160.034 });
    // The affine preview measures unrounded centers; commit measures canonical coordinates
    // before fixing its anchor. Only this x correction crosses a storage quantum.
    expect(previewStroke.pivot).toEqual({ x: 174.931, y: 160.034 });
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
    expect(fixture.overlays[fixture.overlays.length - 2]).toContain(
      "M 140 130 L 340 130 L 340 270 L 140 270 Z",
    );
    expect(fixture.store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 0,
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
    expect(geometry.calculateElementBounds(movedFirst)).toMatchObject({ minX: -602, minY: -502 });
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
  it("keeps a transformed group box current when exact preview materialization is truncated", () => {
    const target = rectangle();
    const dependent = dependentLine();
    const selectedElements = [
      target,
      ...Array.from({ length: 300 }, (_, index) => indexedStroke(index)),
    ];
    const selection = new Set(selectedElements.map(({ id }) => id));
    const { elementPreviews, interaction, overlays, store } = harness(
      [...selectedElements, dependent],
      selection,
    );
    const start = { pointerId: 8, pointerType: "mouse" as const, x: 1011, y: 241 };

    expect(interaction.pointerDown(start)).toBe(true);
    expect(interaction.pointerMove({ ...start, x: 2003, y: 463 })).toBe(true);

    const coordinates = overlays[overlays.length - 2]!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    expect(coordinates[0]).toBeCloseTo(20, 3);
    expect(coordinates[1]).toBeCloseTo(20, 3);
    expect(coordinates[2]).toBeCloseTo(2002, 3);
    expect(coordinates[5]).toBeCloseTo(462, 3); // The centerline handle starts 1px above the pointer.
    const previewLine = elementPreviews[elementPreviews.length - 1]?.find(
      ({ id }) => id === dependent.id,
    );
    expect(previewLine).toBeDefined();
    expect(interaction.pointerUp(start.pointerId)).toBe(true);
    expect(store.get(dependent.id)?.element).toEqual(previewLine);
  });

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
      workScheduler: workSchedulerFromFrames(frameWindow()),
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

function harness(elements: readonly InkElementV1[], selection: ReadonlySet<string>, zoom = 1) {
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
    workScheduler: workSchedulerFromFrames(frameWindow()),
  });
  const renderer = {
    clearElementPreviews: () => elementPreviews.push([]),
    clearPreviewTransforms: () => previewTransforms.push(null),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: (elements: readonly InkElementV1[]) => elementPreviews.push([...elements]),
    setProgressiveElementPreviews:
      vi.fn<NonNullable<HandleInteractionRenderer["setProgressiveElementPreviews"]>>(),
    setOverlayPath: vi.fn(),
    setSelectionOverlayPath: (path: string | null) => overlays.push(path),
    setSnapMarkerPath: (path: string | null) => overlays.push(path),
    setPreviewTransform: (_ids: readonly string[], transform: string | null) =>
      previewTransforms.push(transform),
    suppressMotionForNextDelta: vi.fn(),
  };
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: immediateFrameScheduler(),
    history,
    model,
    pageToScreen: (point) => point,
    preparedHistory,
    renderer,
    sceneStore,
    selection: () => selection,
    zoom: () => zoom,
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
