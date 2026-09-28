import { describe, expect, it, vi } from "vitest";

import {
  calculateElementBounds,
  derivePageExtent,
  rotatePointClockwise,
  translateElementGeometry,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1, PageV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { type ImmutableInkElement } from "../../../../src/domain/store/types";
import { SelectionFrameSession } from "../../../../src/editor/selection/public";
import { transformSelectionFrame } from "../../../../src/editor/selection/selection-frame";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import type { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { MovePreview } from "../../../../src/obsidian/embeds/active-editor/selection-preview";
import { ActivePageLayout } from "../../../../src/obsidian/embeds/active-editor/page-layout";
import { reportedRotatedTable } from "../../../fixtures/editor/reported-rotated-table";
import { createSynchronousActiveEditorHistory } from "../../../fixtures/obsidian/synchronous-active-editor-history";
import { coordinateSystem } from "../../../unit/domain/geometry/fixtures";

describe("active editor mixed selection move", () => {
  it("commits the reported table and stroke geometry atomically", () => {
    const fixture = mixedMoveFixture();
    const { history, store, stroke, table } = fixture;
    const preview = mixedMovePreview(fixture);
    const originalStroke = store.get(stroke.id)!.element;
    if (originalStroke.kind !== "stroke") throw new Error("Expected stored stroke");

    preview.update(pointer(800, 940));

    expect(preview.commit()).toBe(true);
    expect(store.get(table.id)?.element).toMatchObject({
      pivot: { x: 999.694, y: 1062.905 },
      x: 555.405,
      y: 848.169,
    });
    const movedStroke = store.get(stroke.id)?.element;
    if (movedStroke?.kind !== "stroke") throw new Error("Expected moved stroke");
    expect(movedStroke.points).toBe(originalStroke.points);
    expect(movedStroke.offset).toEqual({ x: -100, y: 40 });
    expect(movedStroke.pivot).toEqual({ x: 1489.271, y: 908.189 });
    expect(strokeStart(movedStroke)).toEqual([1697.778, 613.438, 0.5]);
    expect(history.commandCount).toBe(1);
    expect(history.undo()).toBe(true);
    expect(store.get(table.id)?.element).toMatchObject({ x: 655.405, y: 808.169 });
    const restoredStroke = store.get(stroke.id)!.element;
    if (restoredStroke.kind !== "stroke") throw new Error("Expected restored stroke");
    expect(restoredStroke.points).toBe(originalStroke.points);
    expect(restoredStroke.offset).toBeUndefined();
    expect(strokeStart(restoredStroke)).toEqual([1797.778, 573.438, 0.5]);
    expect(history.redo()).toBe(true);
    expect(store.get(stroke.id)?.element).toMatchObject({ offset: { x: -100, y: 40 } });
    expect(strokeStart(store.get(stroke.id)?.element)).toEqual([1697.778, 613.438, 0.5]);
  });
});

describe("active editor oriented multi-selection move", () => {
  it("moves the retained frame with the elements and restores it through undo", () => {
    const fixture = mixedMoveFixture();
    const { history, stroke, table } = fixture;
    const frames = new SelectionFrameSession();
    const geometry = [table, stroke].map((element) => ({
      bounds: calculateElementBounds(element),
      element,
    }));
    const initial = frames.current(geometry)!;
    const rotated = transformSelectionFrame(initial, {
      center: { x: 1_300, y: 900 },
      degrees: 30,
      kind: "rotate",
    });
    frames
      .transition(initial, { center: { x: 1_300, y: 900 }, degrees: 30, kind: "rotate" })
      ?.apply();
    const preview = mixedMovePreview(fixture, frames);

    preview.update(pointer(925, 940));
    expect(preview.commit()).toBe(true);
    expect(frames.current(geometry)?.points[0]).toEqual({
      x: rotated.points[0].x + 25,
      y: rotated.points[0].y + 40,
    });
    expect(frames.current(geometry)?.rotation).toBe(30);
    expect(history.undo()).toBe(true);
    expect(frames.current(geometry)).toEqual(rotated);
  });
});

describe("active editor rotated table move", () => {
  it("commits the reported rotated table across rounding-sensitive destinations", () => {
    const deltas = [
      { x: -1_500.001, y: -2_500.001 },
      { x: -713.255, y: -144.957 },
      { x: -100.001, y: 40.001 },
      { x: -0.001, y: -0.001 },
      { x: 0.001, y: 0.001 },
      { x: 99.999, y: 199.999 },
      { x: 1_024.555, y: 2_048.555 },
    ];

    for (const delta of deltas) {
      const table = reportedRotatedTable();
      const store = new ElementStore([table]);
      const history = createSynchronousActiveEditorHistory(store);
      const finish = vi.fn();
      const fixture = tableMovePreview(store, table, history, finish);

      const currentPointer = pointer(900 + delta.x, 900 + delta.y);
      const previewDelta = { x: currentPointer.x - 900, y: currentPointer.y - 900 };
      fixture.preview.update(currentPointer);

      expect(fixture.setPreviewTransform).toHaveBeenLastCalledWith(
        [table.id],
        `translate(${String(previewDelta.x)} ${String(previewDelta.y)})`,
        1,
      );
      expect(fixture.setSelectionOverlayPath).toHaveBeenLastCalledWith(
        expect.stringContaining("M "),
        "accent",
        expect.stringContaining(" a 5 5 "),
      );
      expect(fixture.updatePreviewBottom).toHaveBeenLastCalledWith(
        calculateElementBounds(table).maxY + previewDelta.y,
      );
      expect(fixture.preview.commit(), JSON.stringify(delta)).toBe(true);
      expect(finish).toHaveBeenLastCalledWith(
        true,
        calculateElementBounds(table).maxY + previewDelta.y,
      );
      const x = Number((table.x + delta.x).toFixed(3));
      const y = Number((table.y + delta.y).toFixed(3));
      expect(store.get(table.id)?.element).toMatchObject({
        pivot: {
          x: Number((x + (table.columns * table.columnWidth) / 2).toFixed(3)),
          y: Number((y + table.height / 2).toFixed(3)),
        },
        rotation: 89.51,
        x,
        y,
      });
    }
  });
});

describe("active editor lower-page extent", () => {
  it("retains the complete table and coordinate-system extent after a millimeter move", () => {
    for (const coordinateOffset of [2_400, 3_900]) {
      const table = reportedRotatedTable();
      const system = translateElementGeometry(coordinateSystem(), { x: 600, y: coordinateOffset });
      const store = new ElementStore([table, system]);
      const history = createSynchronousActiveEditorHistory(store);
      const policy = new ActivePageLayout();
      policy.committed(layoutPage, store.getMaximumBottom());
      policy.beginSelectionMove();
      const finish = vi.fn((committed: boolean, previewBottom?: number) => {
        const storeBottom = store.getMaximumBottom();
        const bottom = committed
          ? Math.max(
              storeBottom ?? Number.NEGATIVE_INFINITY,
              previewBottom ?? Number.NEGATIVE_INFINITY,
            )
          : storeBottom;
        policy.finishSelectionMove(
          committed,
          layoutPage,
          Number.isFinite(bottom) ? bottom : undefined,
        );
      });
      const preview = tableMovePreview(store, table, history, finish).preview;

      preview.update(pointer(900.001, 900.001));

      expect(preview.commit()).toBe(true);
      const requiredHeight = derivePageExtent(
        layoutPage,
        store.getMaximumBottom() ?? null,
      ).activeHeight;
      expect(policy.height).toBeGreaterThanOrEqual(requiredHeight);
      expect(finish).toHaveBeenCalledOnce();
    }
  });
});

const layoutPage: PageV1 = {
  activeBufferLines: 3,
  background: { type: "lines", spacing: 100 },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

function mixedMoveFixture() {
  const table = reportedTable();
  const stroke = reportedStroke();
  const store = new ElementStore([table, stroke]);
  return {
    history: createSynchronousActiveEditorHistory(store),
    selection: new Set([table.id, stroke.id]),
    store,
    stroke,
    table,
  };
}

function mixedMovePreview(
  fixture: ReturnType<typeof mixedMoveFixture>,
  selectionFrames?: SelectionFrameSession,
): MovePreview {
  const renderer = {
    setPreviewTransform: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
    clearPreviewTransforms: vi.fn(),
    setOverlayPath: vi.fn(),
  };
  return new MovePreview({
    history: fixture.history,
    preparedHistory: { commitMove: vi.fn(() => false) } as unknown as PreparedElementHistory,
    renderer,
    sceneStore: {} as ElementSceneStore,
    selection: () => fixture.selection,
    ...(selectionFrames === undefined ? {} : { selectionFrames }),
    setSelection: vi.fn(),
    pageToScreen: (point) => point,
    start: {
      additive: false,
      kind: "element-move",
      pointer: pointer(900, 900),
      tool: "select",
    },
    store: fixture.store,
  });
}

function tableMovePreview(
  store: ElementStore,
  table: Extract<InkElementV1, { kind: "table" }>,
  history: ReturnType<typeof createSynchronousActiveEditorHistory>,
  finish: (committed: boolean, previewBottom?: number) => void,
) {
  const setPreviewTransform = vi.fn();
  const setSelectionOverlayPath = vi.fn();
  const updatePreviewBottom = vi.fn();
  const preview = new MovePreview({
    history,
    preparedHistory: { commitMove: vi.fn(() => false) } as unknown as PreparedElementHistory,
    renderer: {
      clearPreviewTransforms: vi.fn(),
      setOverlayPath: vi.fn(),
      setPreviewTransform,
      setSelectionOverlayPath,
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore: {} as ElementSceneStore,
    selectionEdgeDrag: {
      begin: vi.fn(),
      finish,
      stop: vi.fn(),
      update: vi.fn(),
      updatePreviewBottom,
    },
    pageToScreen: (point) => point,
    selection: () => new Set([table.id]),
    setSelection: vi.fn(),
    start: {
      additive: false,
      kind: "element-move",
      pointer: pointer(900, 900),
      tool: "select",
    },
    store,
  });
  return { preview, setPreviewTransform, setSelectionOverlayPath, updatePreviewBottom };
}

function reportedTable(): Extract<InkElementV1, { kind: "table" }> {
  return {
    columnWidth: 296.193,
    columns: 3,
    createdAt: 1,
    headerHeight: 128.841,
    height: 429.471,
    id: "00000000-0000-4000-8000-000000000001",
    kind: "table",
    pivot: { x: 1099.695, y: 1022.904 },
    rotation: 0,
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
    x: 655.405,
    y: 808.169,
  };
}

function reportedStroke(): Extract<InkElementV1, { kind: "stroke" }> {
  return {
    createdAt: 2,
    id: "00000000-0000-4000-8000-000000000002",
    kind: "stroke",
    pivot: { x: 1589.271, y: 868.189 },
    points: [1797.778, 573.438, 0.5, 1811.762, 581.431, 0.6499, 1827.742, 591.419, 0.53],
    rotation: 0,
    style: {
      color: { type: "rgba", value: "#F97316FF" },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 8,
    },
    tool: "pen",
  };
}

function pointer(x: number, y: number) {
  return { pointerId: 10, pointerType: "mouse" as const, x, y };
}

function strokeStart(element: InkElementV1 | ImmutableInkElement | undefined): number[] {
  if (element?.kind !== "stroke") throw new Error("Expected stroke geometry");
  const point = rotatePointClockwise(
    {
      x: element.points[0]! + (element.offset?.x ?? 0),
      y: element.points[1]! + (element.offset?.y ?? 0),
    },
    element.pivot,
    element.rotation,
  );
  return [point.x, point.y, element.points[2]!];
}
