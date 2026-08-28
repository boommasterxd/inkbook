import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../src/domain/store/public";
import { eventPathHasClass } from "../../../../../src/obsidian/commands/event-path";
import { ActiveEditorBackgroundSession } from "../../../../../src/obsidian/embeds/active-editor/background-session";
import {
  backgroundState,
  createToolbarState,
  isMacPlatform,
  isShapeTool,
  isTool,
  normalizePointerType,
  pageWithBackgroundSpacing,
  pageWithBackgroundType,
} from "../../../../../src/obsidian/embeds/active-editor/controller-helpers";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { ActiveEditorHistoryTraversal } from "../../../../../src/obsidian/embeds/active-editor/history-traversal";
import { ActiveEditorLongPressScheduler } from "../../../../../src/obsidian/embeds/active-editor/long-press";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorStyleSession } from "../../../../../src/obsidian/embeds/active-editor/style-session";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/vault-document-session";
import {
  axisConnectedLine,
  coordinateSystem,
  PAGE,
  rectangle,
} from "../../../domain/store/fixtures";

function historyModel(
  overrides: Partial<ConstructorParameters<typeof ActiveEditorHistory>[0]> = {},
) {
  return {
    commitBandOrder: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    removeElements: vi.fn(),
    replaceElements: vi.fn(),
    ...overrides,
  };
}

class WindowTimerHarness {
  readonly #callbacks = new Map<number, () => void>();
  #nextHandle = 1;
  readonly cleared: number[] = [];

  public readonly window = {
    clearTimeout: (handle: number): void => {
      this.cleared.push(handle);
      this.#callbacks.delete(handle);
    },
    setTimeout: (callback: () => void): number => {
      const handle = this.#nextHandle++;
      this.#callbacks.set(handle, callback);
      return handle;
    },
  } as unknown as Window;

  public fire(handle: number): void {
    const callback = this.#callbacks.get(handle);
    if (callback === undefined) throw new Error(`Timer ${handle} is not pending.`);
    callback();
  }
}

describe("active editor background and history sessions", () => {
  it("commits background changes, skips unavailable spacing, and supports Undo", () => {
    let page = PAGE;
    const onPageChanged = vi.fn();
    const onPagePreviewFinish = vi.fn();
    const onPagePreview = vi.fn();
    const onStateChanged = vi.fn();
    const model = {
      get page() {
        return page;
      },
    } as unknown as EditableDocumentModel;
    const history = new ActiveEditorHistory(
      historyModel({
        commitPage: (replacement) => {
          page = replacement;
        },
      }),
    );
    const session = new ActiveEditorBackgroundSession({
      backgroundSpacing: () => createBuiltInSettings().pageDefaults.backgroundSpacing,
      history,
      model,
      onPageChanged,
      onPagePreviewFinish,
      onPagePreview,
      onStateChanged,
    });

    session.previewSpacing("xl");
    expect(onPagePreview).toHaveBeenCalledWith(
      expect.objectContaining({ background: { type: "lines", spacing: 100 } }),
    );
    expect(page.background).toEqual({ type: "lines", spacing: 50 });
    expect(history.commandCount).toBe(0);
    session.changeSpacing("xl");
    expect(onPagePreviewFinish).toHaveBeenCalledWith(true);
    expect(page.background).toEqual({ type: "lines", spacing: 100 });
    session.changeType("squares");
    expect(page.background).toEqual({ type: "squares", spacing: 25 });
    expect(history.undo()).toBe(true);
    expect(page.background).toEqual({ type: "lines", spacing: 100 });

    session.changeType("none");
    session.changeSpacing("s");
    expect(page.background).toEqual({ type: "none" });
    expect(onPageChanged).toHaveBeenCalledTimes(3);
    expect(onStateChanged).toHaveBeenCalledTimes(3);
  });

  it("blocks overlapping traversal and reports completion for success and failure", async () => {
    const history = new ActiveEditorHistory(historyModel());
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    history.registerApplied({
      payloadBytes: 1,
      redo: async () => true,
      undo: async () => {
        await gate;
        return true;
      },
    });
    const pending = vi.fn();
    const changed = vi.fn();
    const traversal = new ActiveEditorHistoryTraversal({
      history,
      onPendingChanged: pending,
      onStateChanged: changed,
    });

    traversal.undo();
    traversal.redo();
    expect(pending).toHaveBeenLastCalledWith(true);
    release();
    await vi.waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(changed).toHaveBeenCalledTimes(1);

    traversal.redo();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    traversal.dispose();
    traversal.undo();
    expect(pending).toHaveBeenCalledTimes(4);
  });
});

describe("active editor timer and style sessions", () => {
  it("replaces, fires, cancels, and disposes owner-window long-press timers", () => {
    const timers = new WindowTimerHarness();
    const scheduler = new ActiveEditorLongPressScheduler(timers.window);
    const first = vi.fn();
    const replacement = vi.fn();
    const other = vi.fn();

    scheduler.schedule(7, 100, first);
    scheduler.schedule(7, 200, replacement);
    scheduler.schedule(8, 100, other);
    expect(timers.cleared).toEqual([1]);
    timers.fire(2);
    expect(replacement).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    scheduler.cancel(99);
    scheduler.dispose();
    expect(timers.cleared).toEqual([1, 3]);
    expect(other).not.toHaveBeenCalled();
  });

  it("applies selected-element styles through history and otherwise updates session defaults", () => {
    const store = new ElementStore();
    const element = rectangle();
    store.create(element);
    const selected = new Set([element.id]);
    const stateChanged = vi.fn();
    const history = new ActiveEditorHistory(
      historyModel({ replaceElements: (elements) => void store.replaceMany(elements) }),
    );
    const unsubscribe = store.subscribe(() => void stateChanged());
    const session = new ActiveEditorStyleSession({
      defaults: createBuiltInSettings().toolDefaults,
      history,
      onStateChanged: stateChanged,
      sceneStore: new ElementSceneStore(store),
      selection: () => selected,
      store,
    });

    expect(session.presentation("draw").controls.some(({ id }) => id === "outline-width")).toBe(
      true,
    );
    session.apply("draw", "outline-width", 8);
    expect(stateChanged).toHaveBeenCalledTimes(1);
    expect(store.get(element.id)?.element.style).toMatchObject({ outlineWidth: 8 });
    expect(history.undo()).toBe(true);
    expect(stateChanged).toHaveBeenCalledTimes(2);
    expect(store.get(element.id)?.element.style).toMatchObject({ outlineWidth: 4 });

    selected.clear();
    session.apply("draw", "opacity", 0.6);
    expect(session.defaults.pen.opacity).toBe(0.6);
    session.apply("draw", "opacity", 0.6);
    expect(() => session.apply("draw", "unknown", 1)).toThrow(RangeError);
    expect(stateChanged).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("restores propagated connection detachments with the structural Style change", () => {
    const target = coordinateSystem();
    const line = axisConnectedLine();
    const store = new ElementStore([target, line]);
    const history = new ActiveEditorHistory(
      historyModel({ replaceElements: (elements) => void store.replaceMany(elements) }),
    );
    const session = new ActiveEditorStyleSession({
      defaults: createBuiltInSettings().toolDefaults,
      history,
      onStateChanged: vi.fn(),
      sceneStore: new ElementSceneStore(store),
      selection: () => new Set([target.id]),
      store,
    });
    store.resetInstrumentation();

    session.apply("coordinate-system", "coordinate-dimension", "2d");

    expect(store.get(target.id)?.element).toMatchObject({ dimension: "2d" });
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(history.commandCount).toBe(1);
    expect(store.instrumentation.fullStoreScans).toBe(0);

    expect(history.undo()).toBe(true);
    expect(store.get(target.id)?.element).toEqual(target);
    expect(store.get(line.id)?.element).toMatchObject({
      startConnection: {
        anchor: { index: 2, kind: "coordinate-axis-end" },
        targetId: target.id,
      },
    });

    expect(history.redo()).toBe(true);
    expect(store.get(target.id)?.element).toMatchObject({ dimension: "2d" });
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(store.instrumentation.fullStoreScans).toBe(0);
  });
});

describe("active editor host normalization", () => {
  it("normalizes tools, pointer types, backgrounds, and toolbar state", () => {
    expect(isTool("shape")).toBe(true);
    expect(isTool("undo")).toBe(false);
    expect(isShapeTool("rectangle")).toBe(true);
    expect(isShapeTool("draw")).toBe(false);
    expect(normalizePointerType("pen")).toBe("pen");
    expect(normalizePointerType("touch")).toBe("touch");
    expect(normalizePointerType("unknown")).toBe("mouse");
    expect(backgroundState(PAGE)).toEqual({ spacing: "l", type: "lines" });
    expect(backgroundState({ ...PAGE, background: { type: "none" } })).toEqual({
      spacing: null,
      type: "none",
    });
    expect(pageWithBackgroundSpacing(PAGE, "l")?.background).toEqual({
      spacing: 50,
      type: "lines",
    });
    const defaults = { lines: 50, dots: 50, squares: 100 } as const;
    const squares = pageWithBackgroundType(PAGE, "squares", defaults);
    expect(squares.background).toEqual({ spacing: 100, type: "squares" });
    expect(
      pageWithBackgroundType(
        { ...PAGE, background: { spacing: 50, type: "dots" } },
        "squares",
        defaults,
      ).background,
    ).toEqual({ spacing: 100, type: "squares" });
    expect(pageWithBackgroundType(PAGE, "lines", defaults)).toBe(PAGE);
    expect(pageWithBackgroundSpacing(squares, "xl")?.background).toEqual({
      spacing: 100,
      type: "squares",
    });
    expect(pageWithBackgroundSpacing({ ...PAGE, background: { type: "none" } }, "m")).toBeNull();
    expect(
      createToolbarState({
        activeTool: "arrow",
        canPaste: true,
        canRedo: false,
        canUndo: true,
        fingerDrawingAvailable: true,
        fingerDrawingEnabled: false,
        hasSelection: true,
        openFlyout: "style",
      }),
    ).toMatchObject({ activeTool: "shape", canPaste: true, openFlyout: "style" });
  });

  it("uses user-agent data and composed event paths without assuming DOM nodes", () => {
    expect(isMacPlatform({ userAgentData: { platform: "macOS" } } as unknown as Navigator)).toBe(
      true,
    );
    expect(isMacPlatform({ userAgentData: { platform: "Windows" } } as unknown as Navigator)).toBe(
      false,
    );
    expect(isMacPlatform({} as Navigator)).toBe(false);

    const contains = vi.fn((token: string) => token === "inkbook-editor");
    const event = {
      composedPath: () => [null, "text", { classList: {} }, { classList: { contains } }],
    } as unknown as Event;
    expect(eventPathHasClass(event, "inkbook-editor")).toBe(true);
    expect(eventPathHasClass(event, "other")).toBe(false);
    expect(contains).toHaveBeenCalledWith("inkbook-editor");
  });
});
