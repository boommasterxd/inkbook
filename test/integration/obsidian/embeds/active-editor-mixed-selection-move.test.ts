import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore, type ImmutableInkElement } from "../../../../src/domain/store/public";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import type { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { MovePreview } from "../../../../src/obsidian/embeds/active-editor/selection-preview";

describe("active editor mixed selection move", () => {
  it("commits the reported table and stroke geometry atomically", () => {
    const table = reportedTable();
    const stroke = reportedStroke();
    const store = new ElementStore([table, stroke]);
    const history = new ActiveEditorHistory({
      commitBandOrder: vi.fn(),
      commitElements: vi.fn(),
      commitPage: vi.fn(),
      removeElements: vi.fn(),
      replaceElements: (elements) => {
        store.replaceMany(elements);
      },
    });
    const selection = new Set([table.id, stroke.id]);
    const preview = new MovePreview({
      history,
      pageToScreen: (point) => point,
      preparedHistory: { commitMove: vi.fn(() => false) } as unknown as PreparedElementHistory,
      renderer: {
        clearPreviewTransforms: vi.fn(),
        setOverlayPath: vi.fn(),
        setPreviewTransform: vi.fn(),
        suppressMotionForNextDelta: vi.fn(),
      },
      sceneStore: {} as ElementSceneStore,
      selection: () => selection,
      setSelection: vi.fn(),
      start: {
        additive: false,
        kind: "element-move",
        pointer: pointer(900, 900),
        tool: "select",
      },
      store,
    });

    preview.update(pointer(800, 940));

    expect(preview.commit()).toBe(true);
    expect(store.get(table.id)?.element).toMatchObject({
      pivot: { x: 999.694, y: 1062.905 },
      x: 555.405,
      y: 848.169,
    });
    const movedStroke = store.get(stroke.id)?.element;
    expect(movedStroke?.pivot).toEqual({ x: 1489.271, y: 908.189 });
    expect(strokeStart(movedStroke)).toEqual([1697.778, 613.438, 0.5]);
    expect(history.commandCount).toBe(1);
    expect(history.undo()).toBe(true);
    expect(store.get(table.id)?.element).toMatchObject({ x: 655.405, y: 808.169 });
    expect(strokeStart(store.get(stroke.id)?.element)).toEqual([1797.778, 573.438, 0.5]);
  });
});

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
  return element?.kind === "stroke" ? [...element.points.slice(0, 3)] : [];
}
