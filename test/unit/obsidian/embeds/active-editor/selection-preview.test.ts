import { describe, expect, it, vi } from "vitest";

import {
  LassoPreview,
  MovePreview,
  type SelectionEdgeDragPort,
} from "../../../../../src/obsidian/embeds/active-editor/selection-preview";
import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import { MAX_ABSOLUTE_COORDINATE } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { createSynchronousActiveEditorHistory } from "../../../../fixtures/obsidian/synchronous-active-editor-history";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";

const selectedOverlayCall = [expect.any(String), "accent", expect.any(String)];

function createPreview(edgeDrag: SelectionEdgeDragPort) {
  const store = { get: () => undefined } as unknown as ElementStore;
  return new MovePreview({
    history: {} as ActiveEditorHistory,
    pageToScreen: ({ x, y }) => ({ x: x + 10, y: y + 20 }),
    preparedHistory: {} as PreparedElementHistory,
    renderer: {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: vi.fn(),
      setPreviewTransform: vi.fn(),
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore: {
      query: (_bounds: unknown, _sink: unknown) => undefined,
    } as unknown as ElementSceneStore,
    selection: () => new Set(),
    selectionEdgeDrag: edgeDrag,
    setSelection: vi.fn(),
    start: {
      additive: false,
      kind: "element-move",
      pointer: { pointerId: 1, pointerType: "mouse", x: 5, y: 6 },
      tool: "select",
    },
    store,
  });
}

function createEdgeDrag() {
  return {
    begin: vi.fn<() => void>(),
    finish: vi.fn<(committed: boolean, previewMaximumBottom?: number) => void>(),
    stop: vi.fn<() => void>(),
    update: vi.fn<(pointer: { readonly x: number; readonly y: number }) => void>(),
    updatePreviewBottom: vi.fn<(maximumBottom: number) => void>(),
  };
}

describe("selection move edge-drag integration", () => {
  it("holds the page reservation until an accepted prepared move actually completes", () => {
    const edgeDrag = createEdgeDrag();
    let complete: ((committed: boolean) => void) | undefined;
    const element = rectangle();
    const store = new ElementStore([element]);
    const sceneStore = new ElementSceneStore(store);
    const preparedPreview = new MovePreview({
      history: {} as ActiveEditorHistory,
      pageToScreen: (point) => point,
      preparedHistory: {
        commitMove: (
          _elements: unknown,
          _delta: unknown,
          onCompleted?: (committed: boolean) => void,
        ) => {
          complete = onCompleted;
          return true;
        },
      } as unknown as PreparedElementHistory,
      renderer: {
        clearPreviewTransforms: vi.fn(),
        setOverlayPath: vi.fn(),
        setPreviewTransform: vi.fn(),
        suppressMotionForNextDelta: vi.fn(),
      },
      sceneStore,
      selection: () => new Set([element.id]),
      selectionEdgeDrag: edgeDrag,
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: pointer(0, 0),
        tool: "select",
      },
      store,
    });
    preparedPreview.update(pointer(10, 20));

    expect(preparedPreview.commit()).toBe(true);
    expect(edgeDrag.stop).toHaveBeenCalledOnce();
    expect(edgeDrag.finish).not.toHaveBeenCalled();
    complete?.(true);
    expect(edgeDrag.finish).toHaveBeenCalledWith(true, calculateElementBounds(element).maxY + 20);
    sceneStore.release();
  });

  it("forwards screen-space movement and cancellation through the drag lifecycle", () => {
    const edgeDrag = createEdgeDrag();
    const preview = createPreview(edgeDrag);
    expect(edgeDrag.begin).toHaveBeenCalledOnce();

    preview.update({ pointerId: 1, pointerType: "mouse", x: 20, y: 30 });
    expect(edgeDrag.update).toHaveBeenCalledWith({ x: 30, y: 50 });
    preview.revert();
    expect(edgeDrag.finish).toHaveBeenCalledWith(false);
  });

  it("restores the exact committed height even when the move is a no-op", () => {
    const edgeDrag = createEdgeDrag();
    const preview = createPreview(edgeDrag);

    expect(preview.commit()).toBe(false);
    expect(edgeDrag.finish).toHaveBeenCalledWith(false);
  });
});

describe("selection move edge-scroll projection", () => {
  it("reprojects the held viewport point after edge scrolling", () => {
    let refreshViewport: (() => void) | undefined;
    let scrollOffset = 0;
    const edgeDrag = {
      ...createEdgeDrag(),
      begin: vi.fn((refresh?: () => void) => {
        refreshViewport = refresh;
      }),
    };
    const setPreviewTransform = vi.fn();
    const flushPointerFeedbackFrame = vi.fn();
    const preview = new MovePreview({
      history: {} as ActiveEditorHistory,
      pageToScreen: (point) => point,
      pageToViewport: ({ x, y }) => ({ x, y: y - scrollOffset }),
      preparedHistory: {} as PreparedElementHistory,
      renderer: {
        clearPreviewTransforms: vi.fn(),
        flushPointerFeedbackFrame,
        setOverlayPath: vi.fn(),
        setPreviewTransform,
        suppressMotionForNextDelta: vi.fn(),
      },
      sceneStore: {} as ElementSceneStore,
      selection: () => new Set(),
      selectionEdgeDrag: edgeDrag,
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: pointer(10, 20),
        tool: "select",
      },
      store: { get: () => undefined } as unknown as ElementStore,
      viewportToPage: ({ x, y }) => ({ x, y: y + scrollOffset }),
    });

    preview.update(pointer(30, 50));
    expect(setPreviewTransform).toHaveBeenLastCalledWith([], "translate(20 30)", 1);

    scrollOffset = 40;
    refreshViewport?.();

    expect(setPreviewTransform).toHaveBeenLastCalledWith([], "translate(20 70)", 2);
    expect(flushPointerFeedbackFrame).toHaveBeenCalledTimes(2);
    preview.revert();
  });
});

describe("selection move edge-drag validation", () => {
  it("hands a synchronous move from preview to committed geometry atomically", () => {
    const element = rectangle();
    const store = new ElementStore([element]);
    const sceneStore = new ElementSceneStore(store);
    const arm = vi.fn(() => true);
    const cancel = vi.fn();
    const suppressMotionForNextDelta = vi.fn();
    const preview = new MovePreview({
      history: createSynchronousActiveEditorHistory(store),
      pageToScreen: (point) => point,
      preparedHistory: {
        commitMove: vi.fn(() => false),
      } as unknown as PreparedElementHistory,
      renderer: {
        beginPreviewCommit: vi.fn(() => ({ arm, cancel })),
        clearPreviewTransforms: vi.fn(),
        setOverlayPath: vi.fn(),
        setPreviewTransform: vi.fn(),
        suppressMotionForNextDelta,
      },
      sceneStore,
      selection: () => new Set([element.id]),
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: pointer(0, 0),
        tool: "select",
      },
      store,
    });

    preview.update(pointer(12, 18));

    expect(preview.commit()).toBe(true);
    expect(arm).toHaveBeenCalledWith([element.id]);
    expect(cancel).not.toHaveBeenCalled();
    expect(suppressMotionForNextDelta).not.toHaveBeenCalled();
    sceneStore.release();
  });

  it("rejects an out-of-range move and still completes preview cleanup", () => {
    const element = rectangle();
    const store = new ElementStore([element]);
    const edgeDrag = createEdgeDrag();
    const clearPreviewTransforms = vi.fn();
    const setSelectionOverlayPath = vi.fn();
    const selected = new Set([element.id]);
    const start = {
      additive: false,
      kind: "element-move" as const,
      pointer: pointer(0, 0),
      tool: "select" as const,
    };
    const preview = new MovePreview({
      history: { replace: vi.fn() } as unknown as ActiveEditorHistory,
      pageToScreen: (point) => point,
      preparedHistory: {
        commitMove: vi.fn(() => false),
      } as unknown as PreparedElementHistory,
      renderer: {
        clearPreviewTransforms,
        setOverlayPath: vi.fn(),
        setPreviewTransform: vi.fn(),
        setSelectionOverlayPath,
        suppressMotionForNextDelta: vi.fn(),
      },
      sceneStore: {} as ElementSceneStore,
      selection: () => selected,
      selectionEdgeDrag: edgeDrag,
      setSelection: vi.fn(),
      start,
      store,
    });

    preview.update(pointer(MAX_ABSOLUTE_COORDINATE, 0));

    expect(preview.commit()).toBe(false);
    expect(clearPreviewTransforms).toHaveBeenCalledOnce();
    expect(setSelectionOverlayPath.mock.lastCall).toEqual(selectedOverlayCall);
    expect(edgeDrag.finish).toHaveBeenCalledWith(false);
  });
});

describe("selection move connected geometry", () => {
  it("moves a filled bounding overlay by the same preview delta as its element", () => {
    const element = rectangle();
    const store = new ElementStore([element]);
    const setPreviewTransform = vi.fn();
    const setSelectionOverlayPath = vi.fn();
    const renderer = {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: vi.fn(),
      setPreviewTransform,
      setSelectionOverlayPath,
      suppressMotionForNextDelta: vi.fn(),
    };
    const preview = new MovePreview({
      history: {} as ActiveEditorHistory,
      pageToScreen: (point) => point,
      preparedHistory: {} as PreparedElementHistory,
      renderer,
      sceneStore: new ElementSceneStore(store),
      selection: () => new Set([element.id]),
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: pointer(10, 20),
        tool: "select",
      },
      store,
    });

    preview.update(pointer(30, 50));

    expect(setPreviewTransform).toHaveBeenCalledWith([element.id], "translate(20 30)", 1);
    expect(setSelectionOverlayPath.mock.lastCall?.[0]).toContain(
      "M 118 128 L 322 128 L 322 232 L 118 232 Z",
    );
    expect(setSelectionOverlayPath.mock.lastCall).toEqual(selectedOverlayCall);
    preview.update(pointer(40, 60));
    expect(setPreviewTransform.mock.calls[1]?.[0]).toBe(setPreviewTransform.mock.calls[0]?.[0]);
  });

  it("keeps a selected endpoint pinned to an unselected target during preview", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const setElementPreviews = vi.fn();
    const setPreviewTransform = vi.fn();
    const setSelectionOverlayPath = vi.fn();
    const preview = new MovePreview({
      history: {} as ActiveEditorHistory,
      pageToScreen: (point) => point,
      preparedHistory: {} as PreparedElementHistory,
      renderer: {
        clearPreviewTransforms: vi.fn(),
        setElementPreviews,
        setOverlayPath: vi.fn(),
        setPreviewTransform,
        setSelectionOverlayPath,
        suppressMotionForNextDelta: vi.fn(),
      },
      sceneStore: new ElementSceneStore(store),
      selection: () => new Set([line.id]),
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: { pointerId: 2, pointerType: "mouse", x: 0, y: 0 },
        tool: "select",
      },
      store,
    });

    preview.update({ pointerId: 2, pointerType: "mouse", x: 30, y: 40 });

    expect(setElementPreviews.mock.calls[0]?.[0]).toMatchObject([
      { end: { x: 430, y: 140 }, id: line.id, start: { x: 100, y: 100 } },
    ]);
    expect(setPreviewTransform).toHaveBeenCalledWith([], "translate(30 40)", 1);
    expect(setSelectionOverlayPath.mock.calls[0]?.slice(0, 2)).toEqual([null, "none"]);
    expect(setSelectionOverlayPath.mock.calls[0]?.[2]).toContain("M 425 140 a 5 5");
  });
});

describe("selection area preview", () => {
  it.each([
    ["lasso", "preserve"],
    ["rectangle", "latest"],
  ] as const)("uses %s samples in %s mode", (area, mode) => {
    const fixture = selectionAreaHarness({ area, inclusion: "touched" }, rectangle());

    expect(fixture.preview.frameSampleMode).toBe(mode);
    fixture.release();
  });

  it("applies touched and fully-enclosed independently to a rectangle area", () => {
    const element = rectangle();
    const bounds = calculateElementBounds(element);
    const touched = selectionAreaHarness({ area: "rectangle", inclusion: "touched" }, element);
    touched.preview.update(pointer(bounds.minX + 1, bounds.minY + 1));
    expect(touched.preview.commit()).toBe(true);
    expect(touched.selected()).toEqual(new Set([element.id]));
    expect(touched.overlay.mock.calls[touched.overlay.mock.calls.length - 2]?.[0]).toContain(" Z");
    touched.release();

    const enclosed = selectionAreaHarness(
      { area: "rectangle", inclusion: "fully-enclosed" },
      element,
    );
    enclosed.preview.update(pointer(bounds.minX + 1, bounds.minY + 1));
    expect(enclosed.preview.commit()).toBe(false);
    expect(enclosed.selected()).toEqual(new Set());
    enclosed.release();
  });

  it("renders and commits a closed freeform lasso through the spatial query", () => {
    const { bounds, element, fixture } = enclosedLassoHarness();
    encloseRectangle(fixture.preview, bounds);

    expect(fixture.overlay.mock.lastCall?.[0]).toContain(" Z");
    expect(fixture.preview.commit()).toBe(true);
    expect(fixture.selected()).toEqual(new Set([element.id]));
    fixture.release();
  });

  it("commits additive selection against the gesture-start selection snapshot", () => {
    const { bounds, element, fixture } = enclosedLassoHarness({
      additive: true,
      initialSelection: new Set(["selection-at-start"]),
    });
    encloseRectangle(fixture.preview, bounds);
    fixture.replaceSelection(new Set(["late-selection-change"]));

    expect(fixture.preview.commit()).toBe(true);
    expect(fixture.selected()).toEqual(new Set(["selection-at-start", element.id]));
    fixture.release();
  });

  it("bounds a dense freeform pointer path and clears it on cancellation", () => {
    const fixture = selectionAreaHarness({ area: "lasso", inclusion: "touched" }, rectangle());
    fixture.preview.updateSamples(
      Array.from({ length: 4_096 }, (_, index) => ({
        ...pointer(index * 2, index % 2 === 0 ? 20 : 24),
        time: index,
      })),
    );

    const path = fixture.overlay.mock.lastCall?.[0] ?? "";
    expect(path.match(/ L /gu)?.length ?? 0).toBeLessThan(512);
    expect(fixture.overlay).toHaveBeenCalledTimes(2);
    fixture.preview.revert();
    expect(fixture.overlay).toHaveBeenLastCalledWith(null);
    fixture.release();
  });
});

function selectionAreaHarness(
  selectionDefaults: {
    readonly area: "lasso" | "rectangle";
    readonly inclusion: "fully-enclosed" | "touched";
  },
  element: ReturnType<typeof rectangle>,
  start = {
    x: calculateElementBounds(element).minX - 2,
    y: calculateElementBounds(element).minY - 2,
  },
  configuration: {
    readonly additive?: boolean;
    readonly initialSelection?: ReadonlySet<string>;
  } = {},
) {
  const store = new ElementStore([element]);
  const sceneStore = new ElementSceneStore(store);
  const overlay = vi.fn<(path: string | null) => void>();
  let selection: ReadonlySet<string> = new Set(configuration.initialSelection);
  const preview = new LassoPreview({
    history: {} as ActiveEditorHistory,
    pageToScreen: (point) => point,
    preparedHistory: {} as PreparedElementHistory,
    renderer: {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: overlay,
      setPreviewTransform: vi.fn(),
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore,
    selection: () => selection,
    selectionDefaults,
    setSelection: (next) => {
      selection = next;
    },
    start: {
      additive: configuration.additive ?? false,
      kind: "lasso",
      pointer: pointer(start.x, start.y),
      tool: "select",
    },
    store,
  });
  return {
    overlay,
    preview,
    replaceSelection: (next: ReadonlySet<string>) => {
      selection = next;
    },
    release: () => sceneStore.release(),
    selected: () => selection,
  };
}

function enclosedLassoHarness(
  configuration: {
    readonly additive?: boolean;
    readonly initialSelection?: ReadonlySet<string>;
  } = {},
) {
  const element = rectangle();
  const bounds = calculateElementBounds(element);
  return {
    bounds,
    element,
    fixture: selectionAreaHarness(
      { area: "lasso", inclusion: "fully-enclosed" },
      element,
      { x: bounds.minX - 2, y: bounds.minY - 2 },
      configuration,
    ),
  };
}

const pointer = (x: number, y: number) => ({ pointerId: 10, pointerType: "mouse" as const, x, y });

function encloseRectangle(
  preview: LassoPreview,
  bounds: ReturnType<typeof calculateElementBounds>,
): void {
  preview.updateSamples([
    { ...pointer(bounds.maxX + 2, bounds.minY - 2), time: 1 },
    { ...pointer(bounds.maxX + 2, bounds.maxY + 2), time: 2 },
    { ...pointer(bounds.minX - 2, bounds.maxY + 2), time: 3 },
  ]);
}
