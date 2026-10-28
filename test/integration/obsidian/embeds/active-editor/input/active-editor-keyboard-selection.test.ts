// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../../src/domain/store/public";
import type { InkElementV1 } from "../../../../../../src/domain/schema/public";
import { SelectionFrameSession } from "../../../../../../src/editor/selection/public";
import { CanvasKeyboardSelection } from "../../../../../../src/obsidian/embeds/active-editor/input/canvas-keyboard-selection";
import { ActiveEditorHandleInteraction } from "../../../../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorHistory } from "../../../../../../src/obsidian/embeds/active-editor/history";
import type { ActiveEditorControllerOptions } from "../../../../../../src/obsidian/embeds/active-editor/controller-types";
import type { ActiveEditorNavigation } from "../../../../../../src/obsidian/embeds/active-editor/navigation/navigation";
import { installObsidianDomHelpers } from "../../../../../adapters/obsidian/dom";
import { createActiveEditorModel } from "../../../../../fixtures/obsidian/active-controller";
import {
  elementMutationPorts,
  elementReplacementPorts,
} from "../../../../../fixtures/obsidian/element-mutation-ports";
import { activeEditorPreparedHistory } from "../../../../../fixtures/obsidian/active-editor";
import {
  immediateWorkScheduler,
  pausedWorkScheduler,
} from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSelectionPreviewRenderer } from "../../../../../fixtures/obsidian/selection-preview-renderer";
import { rectangle, coordinateSystem, table } from "../../../../../unit/domain/geometry/fixtures";
import { createDragElement } from "../../../../../../src/editor/tools/public";
import { createBuiltInSettings } from "../../../../../../src/domain/settings";
import { updateEmbedDescription } from "../../../../../../src/obsidian/embeds/presentation/embed-description";
import { CanvasKeyboardStatus } from "../../../../../../src/obsidian/embeds/active-editor/input/canvas-keyboard-status";
import { createNavigationHarness } from "../../../../../fixtures/obsidian/navigation";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture(
  elements: readonly InkElementV1[] = [rectangle({ x: 100, y: 100, pivot: { x: 150, y: 125 } })],
  scheduler = immediateWorkScheduler(),
  initialSelection: readonly string[] = [],
) {
  const store = new ElementStore(elements);
  const scene = new ElementSceneStore(store);
  let selection: ReadonlySet<string> = new Set(initialSelection);
  let revision = 0;
  const advance = () => {
    revision += 1;
  };
  const model = {
    ...createActiveEditorModel(store),
    ...elementReplacementPorts(store, advance),
    ...elementMutationPorts(store, advance),
    get revision() {
      return revision;
    },
  };
  const history = new ActiveEditorHistory(model);
  const prepared = activeEditorPreparedHistory(model, history, scheduler);
  const input = document.body.createDiv();
  input.tabIndex = 0;
  const renderer = keyboardRenderer(input);
  const frames = new SelectionFrameSession();
  const handles = new ActiveEditorHandleInteraction({
    model,
    history,
    preparedHistory: prepared,
    renderer,
    sceneStore: scene,
    frameScheduler: scheduler,
    workScheduler: scheduler,
    selectionFrames: frames,
    pageToScreen: (point) => point,
    selection: () => selection,
    zoom: () => 1,
  });
  const revealBounds = vi.fn();
  const layout = { begin: vi.fn(), finish: vi.fn(), updateBottom: vi.fn() };
  const navigation = { revealBounds } as unknown as ActiveEditorNavigation;
  const keyboard = new CanvasKeyboardSelection({
    controller: {
      model,
      history,
      renderer,
      sceneStore: scene,
      selectionMoveLayout: layout,
    } as unknown as ActiveEditorControllerOptions,
    handles,
    frames,
    preparedHistory: prepared,
    navigation,
    enabled: () => true,
    selection: () => selection,
    zoom: () => 1,
    setSelection: (next) => {
      prepared.cancel();
      frames.reset();
      selection = next;
      handles.renderSelection();
    },
  });
  const send = (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: value, ...options });
    Object.defineProperty(event, "target", { value: input });
    return keyboard.handle(event);
  };
  input.focus();
  return {
    store,
    history,
    send,
    input,
    keyboard,
    revealBounds,
    layout,
    selection: () => selection,
    dispose: () => {
      keyboard.dispose();
      prepared.dispose();
      handles.dispose();
      history.dispose();
      scene.release();
      input.remove();
    },
  };
}

function keyboardRenderer(inputSurface: HTMLDivElement) {
  return {
    ...createSelectionPreviewRenderer(),
    inputSurface,
    clearElementPreviews: vi.fn(),
    setElementPreviews: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
    setSelectionOverlayPath: vi.fn(),
    setSnapMarkerPath: vi.fn(),
  };
}

describe("canvas keyboard presentation", () => {
  it.each([
    { top: -200, scrollTop: 300, minY: 0, direction: -1 },
    { top: 100, scrollTop: 200, minY: 1000, direction: 1 },
  ])(
    "reveals an object with the native scroll adapter in direction $direction",
    ({ top, scrollTop, minY, direction }) => {
      const test = createNavigationHarness({
        containerRect: { left: 0, top, width: 1000, height: 2000 },
        ownerScrollTop: scrollTop,
        ownerScrollHeight: 4000,
      });
      try {
        test.navigation.restoreViewState({ cameraX: 0, zoom: 1 });
        const before = test.owner.scrollTop;
        test.navigation.revealBounds({ minX: 100, maxX: 200, minY, maxY: minY + 50 });
        test.frames.flushAll();
        expect((test.owner.scrollTop - before) * direction).toBeGreaterThan(0);
        const visibleTop = top + minY + before - test.owner.scrollTop;
        expect(visibleTop).toBeGreaterThanOrEqual(16);
        expect(visibleTop + 50).toBeLessThanOrEqual(484);
        expect(test.navigation.cameraX).toBe(0);
        expect(test.frames.pending).toBe(0);
      } finally {
        test.navigation.dispose();
      }
    },
  );
  it("keeps author text available to the active canvas and releases its binding", () => {
    const root = document.body.createDiv();
    root.className = "inkbook-embed-root";
    const preview = root.createEl("button");
    updateEmbedDescription(root, preview, "Supply and demand");
    const surface = root.createDiv();
    const status = new CanvasKeyboardStatus(surface);
    const descriptions = () =>
      (surface.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent);
    expect(descriptions()).toContain("Supply and demand");
    updateEmbedDescription(root, undefined, "<img src=x>");
    expect(descriptions()).toContain("<img src=x>");
    expect(root.querySelector("img")).toBeNull();
    status.dispose();
    expect(surface.hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("canvas keyboard selection and connections", () => {
  it("moves a connected target and its endpoint atomically and restores both with undo", async () => {
    const target = rectangle({ x: 100, y: 100, pivot: { x: 150, y: 125 } });
    const dependent = createDragElement({
      defaults: createBuiltInSettings().toolDefaults,
      tool: "line",
      start: { x: 200, y: 125 },
      end: { x: 400, y: 125 },
      startConnection: { targetId: target.id, anchor: { kind: "box", position: "middle-right" } },
      identity: { id: "00000000-0000-4000-8000-000000000011", createdAt: 1 },
    });
    const test = fixture([target, dependent]);
    try {
      test.send("Home");
      test.send("Enter");
      test.send("ArrowRight");
      await vi.waitFor(() => expect(test.history.commandCount).toBe(1));
      expect(test.store.get(target.id)!.element).toMatchObject({ x: 101 });
      expect(test.store.get(dependent.id)!.element).toMatchObject({ start: { x: 201, y: 125 } });
      expect(await test.history.undoAsync()).toBe(true);
      expect(test.store.get(target.id)!.element).toMatchObject({ x: 100 });
      expect(test.store.get(dependent.id)!.element).toMatchObject({ start: { x: 200, y: 125 } });
    } finally {
      test.dispose();
    }
  });
  it("navigates objects, extends selection and keeps system shortcuts and Tab available", () => {
    const first = rectangle();
    const last = rectangle({
      id: "00000000-0000-4000-8000-000000000009",
      x: 500,
      pivot: { x: 550, y: 25 },
    });
    const test = fixture([first, last]);
    try {
      expect(test.send("PageDown")).toBe(true);
      expect([...test.selection()]).toEqual([first.id]);
      test.send("PageDown", { shiftKey: true });
      expect([...test.selection()]).toEqual([first.id, last.id]);
      expect(test.revealBounds).toHaveBeenCalledWith(test.store.get(last.id)!.bounds);
      expect(test.send("Home", { ctrlKey: true })).toBe(false);
      expect(test.send("PageDown", { altKey: true })).toBe(false);
      test.send("Home");
      expect([...test.selection()]).toEqual([first.id]);
      test.send("Enter");
      expect(test.send("Tab")).toBe(false);
      expect(test.send("ArrowRight")).toBe(false);
      test.send("End");
      expect([...test.selection()]).toEqual([last.id]);
    } finally {
      test.dispose();
    }
  });
});

describe("canvas keyboard geometry and cancellation", () => {
  it("moves, resizes and rotates through the existing atomic history", async () => {
    const test = fixture();
    try {
      test.send("Home");
      test.send("Enter");
      test.send("ArrowRight", { shiftKey: true });
      expect(test.store.get(test.store.idAtRank("content", 0)!)!.element).toMatchObject({ x: 110 });
      expect(test.history.commandCount).toBe(1);
      test.send("PageDown");
      test.send("ArrowLeft");
      expect(test.store.get(test.store.idAtRank("content", 0)!)!.element).toMatchObject({
        x: 109,
        width: 101,
      });
      expect(test.history.commandCount).toBe(2);
      for (
        let index = 0;
        index < 20 && !test.input.querySelector('[role="status"]')?.textContent?.includes("Rotate");
        index += 1
      )
        test.send("PageDown");
      expect(test.input.querySelector('[role="status"]')?.textContent).toContain("Rotate");
      test.send("ArrowRight");
      expect(test.store.get(test.store.idAtRank("content", 0)!)!.element.rotation).toBeCloseTo(1);
      expect(await test.history.undoAsync()).toBe(true);
      expect(test.store.get(test.store.idAtRank("content", 0)!)!.element.rotation).toBe(0);
      expect(await test.history.redoAsync()).toBe(true);
      expect(test.store.get(test.store.idAtRank("content", 0)!)!.element.rotation).toBeCloseTo(1);
      expect(test.input.querySelector('[role="status"]')?.textContent).toContain("Rotate");
    } finally {
      test.dispose();
    }
  });

  it.each(["Escape", "Tab", "dispose"])(
    "cancels a suspended large-selection edit on %s",
    async (exit) => {
      const paused = pausedWorkScheduler();
      const elements = Array.from({ length: 1001 }, (_, index) =>
        rectangle({
          id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
          x: index * 2,
          pivot: { x: index * 2 + 50, y: 25 },
        }),
      );
      const test = fixture(
        elements,
        paused.scheduler,
        elements.map(({ id }) => id),
      );
      test.send("Enter");
      test.send("ArrowRight");
      if (exit === "dispose") test.dispose();
      else test.send(exit);
      paused.resume();
      await vi.waitFor(() => expect(test.layout.finish).toHaveBeenCalledWith(false));
      expect(test.history.commandCount).toBe(0);
      expect(test.store.get(elements[0]!.id)!.element).toMatchObject({ x: 0 });
      if (exit !== "dispose") test.dispose();
    },
  );
});

describe("canvas keyboard structural handles", () => {
  it.each([
    {
      element: coordinateSystem(),
      handle: "Coordinate origin",
      property: "origin",
      expected: { x: 101, y: 100 },
    },
    { element: table(), handle: "Table header", property: "headerHeight", expected: 31 },
    {
      element: createDragElement({
        defaults: createBuiltInSettings().toolDefaults,
        start: { x: 100, y: 100 },
        end: { x: 300, y: 100 },
        identity: { id: "00000000-0000-4000-8000-000000000010", createdAt: 1 },
        tool: "line",
      }),
      handle: "Line start",
      property: "start",
      expected: { x: 101, y: 100 },
    },
  ])(
    "edits $handle through the existing structural transform",
    ({ element, handle, property, expected }) => {
      const test = fixture([element]);
      try {
        test.send("Home");
        test.send("Enter");
        for (
          let index = 0;
          index < 20 && !test.input.querySelector('[role="status"]')?.textContent?.includes(handle);
          index += 1
        )
          test.send("PageDown");
        expect(test.input.querySelector('[role="status"]')?.textContent).toContain(handle);
        test.send(handle === "Table header" ? "ArrowDown" : "ArrowRight");
        expect(test.store.get(element.id)!.element).toMatchObject({ [property]: expected });
        expect(test.history.commandCount).toBe(1);
      } finally {
        test.dispose();
      }
    },
  );
});
