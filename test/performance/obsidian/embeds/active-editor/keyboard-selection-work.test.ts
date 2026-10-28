// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import { SelectionFrameSession } from "../../../../../src/editor/selection/public";
import { CanvasKeyboardSelection } from "../../../../../src/obsidian/embeds/active-editor/input/canvas-keyboard-selection";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import * as geometry from "../../../../../src/domain/geometry/public";
import type { ActiveEditorControllerOptions } from "../../../../../src/obsidian/embeds/active-editor/controller-types";
import { ActiveEditorHandleInteraction } from "../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { createActiveEditorModel } from "../../../../fixtures/obsidian/active-controller";
import {
  elementMutationPorts,
  elementReplacementPorts,
} from "../../../../fixtures/obsidian/element-mutation-ports";
import { activeEditorPreparedHistory } from "../../../../fixtures/obsidian/active-editor";
import { pausedWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSelectionPreviewRenderer } from "../../../../fixtures/obsidian/selection-preview-renderer";
import {
  createConnectedTranslationFixture,
  CONNECTED_DEPENDENT_COUNT,
} from "../../../editor/connected-translation-fixture";

beforeEach(installObsidianDomHelpers);

it.each([100, 10_000])(
  "bounds keyboard navigation record and order work with %s strokes",
  (count) => {
    const store = new ElementStore(
      Array.from({ length: count }, (_, index) => indexedStroke(index)),
    );
    const input = document.body.createDiv();
    let selection: ReadonlySet<string> = new Set();
    const read = vi.spyOn(store, "get");
    const rank = vi.spyOn(store, "getRank");
    const at = vi.spyOn(store, "idAtRank");
    const order = vi.spyOn(store, "materializeBandOrder");
    const revealBounds = vi.fn();
    const keyboard = new CanvasKeyboardSelection({
      controller: { model: { store }, renderer: { inputSurface: input } } as never,
      handles: { setKeyboardFocus: vi.fn() } as never,
      frames: new SelectionFrameSession(),
      preparedHistory: {} as never,
      navigation: { revealBounds } as never,
      enabled: () => true,
      zoom: () => 1,
      selection: () => selection,
      setSelection: (next) => {
        selection = next;
      },
    });
    const send = keyboardSender(keyboard, input);
    try {
      for (const key of ["Home", "PageDown", "End", "PageUp"]) {
        read.mockClear();
        rank.mockClear();
        at.mockClear();
        expect(send(key)).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
        expect(at).toHaveBeenCalledTimes(1);
        expect(rank.mock.calls.length).toBeLessThanOrEqual(1);
        expect(order).not.toHaveBeenCalled();
      }
      const current = selection.values().next().value!;
      store.remove(new Set([current]));
      read.mockClear();
      at.mockClear();
      send("PageDown");
      expect(selection.has(store.idAtRank("content", 0)!)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      expect(at.mock.calls.length).toBeLessThanOrEqual(2);
      expect(revealBounds).toHaveBeenCalledTimes(5);
      keyboard.dispose();
      expect(input.children.length).toBe(0);
      expect(input.hasAttribute("aria-describedby")).toBe(false);
      expect(send("Home")).toBe(false);
    } finally {
      keyboard.dispose();
      input.remove();
      vi.restoreAllMocks();
    }
  },
);

it("bounds admission work and commits and undoes a connected 10,000-stroke keyboard move", async () => {
  const test = connectedKeyboardFixture();
  const { store, keyboard, input, history, handles, paused, selectedIds, target } = test;
  const [connection] = store.beginDependents(target.id);
  if (!connection) throw new Error("The connected fixture requires a dependent endpoint.");
  const dependent = connection.linearId;
  const originalGeometry = handles.selectionGeometry();
  let selectionReads = 0;
  const observed = originalGeometry.map((record) => ({
    bounds: record.bounds,
    get element() {
      selectionReads += 1;
      return record.element;
    },
  }));
  const selected = vi
    .spyOn(handles, "selectionGeometry")
    .mockImplementation(() => originalGeometry);
  const send = keyboardSender(keyboard, input);
  try {
    send("Enter");
    selected.mockReturnValue(observed);
    const checkpoint = vi.spyOn(paused.scheduler, "checkpoint");
    const canonical = vi.spyOn(geometry, "canonicalPoint");
    store.resetInstrumentation();
    expect(send("ArrowRight")).toBe(true);
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
    // One immutable transaction snapshot plus one admitted translation unit precede the pause.
    expect(selectionReads).toBe(selectedIds.size);
    expect(canonical.mock.calls.length).toBeLessThanOrEqual(2);
    expect(store.instrumentation).toMatchObject({
      recordReplacements: 0,
      publishedDeltas: 0,
      fullStoreScans: 0,
      snapshotMaterializations: 0,
    });
    selected.mockRestore();
    paused.resume();
    await vi.waitFor(() => expect(history.commandCount).toBe(1));
    expect(store.get(target.id)!.element).toMatchObject({ x: target.x + 1 });
    expect(store.get(dependent)!.element).toMatchObject({
      start: { x: target.x + 1, y: target.y },
    });
    expect(store.instrumentation.recordReplacements).toBe(
      selectedIds.size + CONNECTED_DEPENDENT_COUNT,
    );
    expect(store.instrumentation.publishedDeltas).toBe(1);
    expect(store.instrumentation.reverseDependencyVisits).toBeLessThanOrEqual(
      CONNECTED_DEPENDENT_COUNT * 4,
    );
    store.resetInstrumentation();
    expect(await history.undoAsync()).toBe(true);
    expect(store.get(target.id)!.element).toMatchObject({ x: target.x });
    expect(store.get(dependent)!.element).toMatchObject({ start: { x: target.x, y: target.y } });
    expect(store.instrumentation.recordReplacements).toBe(
      selectedIds.size + CONNECTED_DEPENDENT_COUNT,
    );
    expect(store.instrumentation.publishedDeltas).toBe(1);
    expect(store.instrumentation.fullStoreScans).toBe(0);
  } finally {
    paused.resume();
    test.dispose();
    vi.restoreAllMocks();
  }
});

function keyboardSender(keyboard: CanvasKeyboardSelection, input: HTMLDivElement) {
  return (key: string) => {
    const event = new KeyboardEvent("keydown", { key });
    Object.defineProperty(event, "target", { value: input });
    return keyboard.handle(event);
  };
}

function connectedKeyboardFixture() {
  const { store, selectedIds, target } = createConnectedTranslationFixture();
  const paused = pausedWorkScheduler();
  const work = {
    shouldYield: () => paused.scheduler.shouldYield(),
    yieldControl: () => paused.scheduler.checkpoint() ?? Promise.resolve(),
  };
  let revision = 0;
  const changed = () => {
    revision += 1;
  };
  const model = {
    ...createActiveEditorModel(store),
    ...elementReplacementPorts(store, changed, work),
    ...elementMutationPorts(store, changed, work),
    get revision() {
      return revision;
    },
  };
  const history = new ActiveEditorHistory(model);
  const prepared = activeEditorPreparedHistory(model, history, paused.scheduler);
  const sceneStore = new ElementSceneStore(store);
  const input = document.body.createDiv();
  const renderer = {
    ...createSelectionPreviewRenderer(),
    inputSurface: input,
    clearElementPreviews: vi.fn(),
    setElementPreviews: vi.fn(),
    setSelectionOverlayPath: vi.fn(),
    setSnapMarkerPath: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
  };
  const frames = new SelectionFrameSession();
  const handles = new ActiveEditorHandleInteraction({
    model,
    history,
    preparedHistory: prepared,
    renderer,
    sceneStore,
    frameScheduler: paused.scheduler,
    workScheduler: paused.scheduler,
    selection: () => selectedIds,
    selectionFrames: frames,
    pageToScreen: (point) => point,
    zoom: () => 1,
  });
  const controller = {
    model,
    history,
    renderer,
    sceneStore,
    selectionMoveLayout: { begin: vi.fn(), finish: vi.fn(), updateBottom: vi.fn() },
  } as unknown as ActiveEditorControllerOptions;
  const keyboard = new CanvasKeyboardSelection({
    controller,
    handles,
    frames,
    preparedHistory: prepared,
    navigation: { revealBounds: vi.fn() } as never,
    selection: () => selectedIds,
    setSelection: vi.fn(),
    enabled: () => true,
    zoom: () => 1,
  });
  return {
    store,
    selectedIds,
    target,
    paused,
    history,
    input,
    keyboard,
    handles,
    dispose: () => {
      keyboard.dispose();
      prepared.dispose();
      handles.dispose();
      history.dispose();
      sceneStore.release();
      input.remove();
    },
  };
}
