import { describe, expect, it, vi } from "vitest";

import {
  calculateElementBounds,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { layoutSelectionHandles } from "../../../../src/editor/selection/handles";
import {
  oppositeElementHandlePoint,
  SelectionFrameSession,
} from "../../../../src/editor/selection/public";
import { editLinearBend } from "../../../../src/editor/selection/linear-bend";
import { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { immediateFrameScheduler } from "../../../fixtures/obsidian/immediate-frame-scheduler";
import {
  connectedLine,
  coordinateSystem,
  rectangle as storeRectangle,
} from "../../../unit/domain/store/fixtures";

function rectangle(): Extract<InkElementV1, { kind: "rectangle" }> {
  const element = storeRectangle("00000000-0000-4000-8000-000000000001");
  if (element.kind !== "rectangle") throw new TypeError("Expected a rectangle fixture.");
  return { ...element, height: 140, pivot: { x: 200, y: 170 } };
}

function line(): Extract<InkElementV1, { kind: "line" }> {
  return {
    ...connectedLine(),
    end: { x: 50, y: 50 },
    pivot: { x: 30, y: 30 },
    start: { x: 10, y: 10 },
    startConnection: null,
  };
}

function parseGuideAxis(path: string | null | undefined): {
  readonly end: PointV1;
  readonly start: PointV1;
} {
  const match = path?.match(/^M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)$/);
  if (match === undefined || match === null) throw new TypeError("Expected one guide axis.");
  return {
    end: { x: Number(match[3]), y: Number(match[4]) },
    start: { x: Number(match[1]), y: Number(match[2]) },
  };
}

function distance(first: PointV1, second: PointV1): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointLineDistance(
  point: PointV1,
  line: { readonly end: PointV1; readonly start: PointV1 },
): number {
  const delta = { x: line.end.x - line.start.x, y: line.end.y - line.start.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length === 0) return distance(point, line.start);
  return Math.abs(delta.x * (line.start.y - point.y) - delta.y * (line.start.x - point.x)) / length;
}

describe("active editor handle page extent", () => {
  it.each([null, { x: 200, y: 200 }])(
    "uses bounded selected line hit geometry for hover: %s",
    (bend) => {
      const element = { ...line(), start: { x: 0, y: 0 }, end: { x: 400, y: 0 }, bend };
      const fixture = harness([element], 1);
      fixture.interaction.renderSelection();
      const read = vi.spyOn(fixture.store, "get");
      const pointer = {
        pointerId: 1,
        pointerType: "mouse" as const,
        x: 100,
        y: bend === null ? 7 : 75,
      };
      expect(fixture.interaction.cursorAt(pointer)).toBe("move");
      expect(fixture.interaction.cursorAt({ ...pointer, y: 150 })).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
      fixture.interaction.dispose();
    },
  );
  it("resolves repeated hover from cached geometry without reading selected elements", () => {
    const element = rectangle();
    const selection = new Set([element.id]);
    const fixture = harness([element], 1, selection);
    const pointer = { pointerId: 1, pointerType: "mouse" as const, x: 200, y: 170 };
    fixture.interaction.renderSelection();
    const read = vi.spyOn(fixture.store, "get");
    for (let index = 0; index < 100; index += 1) {
      expect(fixture.interaction.cursorAt(pointer)).toBe("move");
      expect(fixture.interaction.cursorAt({ ...pointer, x: -100 })).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
    selection.clear();
    fixture.interaction.renderSelection();
    expect(fixture.interaction.cursorAt(pointer)).toBeUndefined();
    fixture.interaction.dispose();
  });
  it("reserves preview height for handle geometry until commit", () => {
    const element = rectangle();
    const bounds = calculateElementBounds(element);
    const fixture = harness([element], 1);
    const pointer = {
      pointerId: 18,
      pointerType: "mouse" as const,
      x: bounds.maxX,
      y: bounds.maxY,
    };

    fixture.interaction.renderSelection();
    expect(fixture.interaction.cursorAt(pointer)).toBe("nwse-resize");
    expect(fixture.interaction.pointerDown(pointer)).toBe(true);
    expect(fixture.interaction.cursorAt({ ...pointer, x: -100 })).toBe("nwse-resize");
    expect(fixture.layout.begin).toHaveBeenCalledOnce();
    expect(fixture.interaction.pointerMove({ ...pointer, y: pointer.y + 300 })).toBe(true);
    expect(fixture.layout.updateBottom).toHaveBeenLastCalledWith(expect.any(Number));
    const calls = fixture.layout.updateBottom.mock.calls;
    const previewBottom = Number(calls[calls.length - 1]?.[0]);
    expect(previewBottom).toBeGreaterThan(bounds.maxY);
    expect(fixture.interaction.pointerUp(pointer.pointerId)).toBe(true);
    expect(fixture.layout.finish).toHaveBeenCalledWith(true, previewBottom);
  });
});

describe("active editor selection handle targets", () => {
  it("uses forgiving pointer targets that remain precise at high zoom", () => {
    const element = rectangle();
    const bounds = calculateElementBounds(element);
    const nearTopLeft = { pointerId: 20, x: bounds.minX + 15, y: bounds.minY };
    expect(
      harness([element], 1).interaction.pointerDown({
        ...nearTopLeft,
        pointerType: "mouse",
      }),
    ).toBe(false);
    const mouse = harness([element], 1);
    expect(
      mouse.interaction.pointerDown({
        ...nearTopLeft,
        pointerId: 19,
        pointerType: "mouse",
        x: bounds.minX + 12.5,
      }),
    ).toBe(true);
    mouse.interaction.cancel(19);
    const pen = harness([element], 1);
    expect(pen.interaction.pointerDown({ ...nearTopLeft, pointerType: "pen" })).toBe(true);
    pen.interaction.cancel(nearTopLeft.pointerId);
    const touch = harness([element], 1);
    expect(
      touch.interaction.pointerDown({
        ...nearTopLeft,
        pointerType: "touch",
        x: bounds.minX + 23,
      }),
    ).toBe(true);
    touch.interaction.cancel(nearTopLeft.pointerId);

    const zoomed = harness([element], 4);
    expect(
      zoomed.interaction.pointerDown({
        ...nearTopLeft,
        pointerType: "touch",
        x: bounds.minX + 5,
      }),
    ).toBe(false);
    expect(
      zoomed.interaction.pointerDown({
        ...nearTopLeft,
        pointerId: 21,
        pointerType: "touch",
        x: bounds.minX + 2,
      }),
    ).toBe(true);
    zoomed.interaction.cancel(21);
  });

  it("preserves the grab offset when resizing from an expanded touch target", () => {
    const element = rectangle();
    const bounds = calculateElementBounds(element);
    const fixture = harness([element], 1);
    const pointer = {
      pointerId: 23,
      pointerType: "touch" as const,
      x: bounds.maxX - 12,
      y: bounds.maxY,
    };
    expect(fixture.interaction.pointerDown(pointer)).toBe(true);
    expect(fixture.interaction.pointerMove({ ...pointer, x: pointer.x + 1 })).toBe(true);
    expect(fixture.interaction.pointerUp(pointer.pointerId)).toBe(true);
    expect(fixture.store.get(element.id)?.element).toMatchObject({ height: element.height });
    expect(fixture.store.get(element.id)?.element).toHaveProperty("width", element.width + 1);
  });

  it.each(["rotate", "linear-bend"] as const)(
    "applies the larger touch target to the %s handle",
    (kind) => {
      const element = kind === "rotate" ? rectangle() : line();
      const handle = layoutSelectionHandles(
        [{ bounds: calculateElementBounds(element), element }],
        { zoom: 1 },
      ).find((candidate) => candidate.kind === kind);
      if (handle === undefined) throw new TypeError(`Expected a ${kind} handle.`);
      const fixture = harness([element], 1);

      expect(
        fixture.interaction.pointerDown({
          pointerId: 22,
          pointerType: "touch",
          x: handle.point.x + 18,
          y: handle.point.y,
        }),
      ).toBe(true);
      fixture.interaction.cancel(22);
    },
  );
});

describe("active editor selection interior handle arbitration", () => {
  it("keeps the center of a small low-zoom selection available for touch move", () => {
    const element = rectangle();
    const bounds = calculateElementBounds(element);
    const zoom = 0.15;
    const center = {
      pointerId: 24,
      pointerType: "touch" as const,
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    expect(harness([element], zoom).interaction.pointerDown(center)).toBe(false);

    const nearTopCenter = harness([element], zoom);
    expect(
      nearTopCenter.interaction.pointerDown({
        ...center,
        pointerId: 25,
        y: bounds.minY + 8 / zoom,
      }),
    ).toBe(true);
    nearTopCenter.interaction.cancel(25);
  });
});

describe("active editor selection snap guides", () => {
  it("renders a complete rotation axis and chord bend guides through the live overlay", () => {
    const shape = rectangle();
    const rotation = harness([shape], 1);
    const rotateHandle = layoutSelectionHandles(
      [{ bounds: calculateElementBounds(shape), element: shape }],
      { zoom: 1 },
    ).find(({ kind }) => kind === "rotate");
    if (rotateHandle === undefined) throw new TypeError("Expected a rotation handle.");
    rotation.interaction.pointerDown({
      ...rotateHandle.point,
      pointerId: 24,
      pointerType: "touch",
    });
    rotation.interaction.pointerMove({
      pointerId: 24,
      pointerType: "touch",
      x: shape.pivot.x + 98,
      y: shape.pivot.y,
    });
    expect(rotation.overlays[rotation.overlays.length - 1]).toBe("M 104 170 L 324 170");
    rotation.interaction.cancel(24);

    const linear = line();
    const bend = harness([linear], 1);
    bend.interaction.pointerDown({ pointerId: 25, pointerType: "touch", x: 30, y: 30 });
    bend.interaction.pointerMove({ pointerId: 25, pointerType: "touch", x: 32, y: 32 });
    expect(bend.overlays[bend.overlays.length - 1]).toContain(
      "M -6.970562748477139 -6.970562748477139 L 66.97056274847714 66.97056274847714",
    );
    bend.interaction.cancel(25);
  });

  it("keeps a rotation guide on the bounding-box handle axis when the pivot is offset", () => {
    const system = coordinateSystem();
    const fixture = harness([system], 1);
    const rotateHandle = layoutSelectionHandles(
      [{ bounds: calculateElementBounds(system), element: system }],
      { zoom: 1 },
    ).find(({ kind }) => kind === "rotate");
    if (rotateHandle === undefined) throw new TypeError("Expected a rotation handle.");
    const pointerId = 29;

    fixture.interaction.pointerDown({ ...rotateHandle.point, pointerId, pointerType: "mouse" });
    const rotatedHandle = rotatePointClockwise(rotateHandle.point, system.pivot, 90);
    fixture.interaction.pointerMove({ ...rotatedHandle, pointerId, pointerType: "mouse" });

    const guide = parseGuideAxis(fixture.overlays[fixture.overlays.length - 1]);
    const opposite = rotatePointClockwise(
      oppositeElementHandlePoint(system, "top-center"),
      system.pivot,
      90,
    );
    const boxAnchor = rotatePointClockwise(
      oppositeElementHandlePoint(system, "bottom-center"),
      system.pivot,
      90,
    );
    expect(distance(guide.start, opposite)).toBeCloseTo(24, 8);
    expect(distance(guide.end, rotatedHandle)).toBeCloseTo(24, 8);
    expect(pointLineDistance(boxAnchor, guide)).toBeCloseTo(0, 8);
    expect(pointLineDistance(opposite, guide)).toBeCloseTo(0, 8);
    expect(pointLineDistance(rotatedHandle, guide)).toBeCloseTo(0, 8);
    fixture.interaction.cancel(pointerId);
  });

  it("renders an offset anchor marker and persists endpoint attachment and detachment", () => {
    const selectedLine = line();
    const fixture = harness([rectangle(), selectedLine], 1);
    const start = {
      pointerId: 26,
      pointerType: "mouse" as const,
      x: selectedLine.end.x,
      y: selectedLine.end.y,
    };

    fixture.interaction.pointerDown(start);
    fixture.interaction.pointerMove({ ...start, x: 100, y: 100 });
    expect(fixture.overlays[fixture.overlays.length - 1]).toContain("M 88 100 L 112 100");
    expect(fixture.overlays[fixture.overlays.length - 1]).not.toContain("Z");
    fixture.interaction.pointerUp(start.pointerId);
    const connected = fixture.store.get(selectedLine.id)?.element;
    expect(connected).toMatchObject({
      endConnection: {
        anchor: { kind: "box", position: "top-left" },
        targetId: rectangle().id,
      },
    });
    if (connected?.kind !== "line") throw new TypeError("Expected a connected line.");

    fixture.interaction.pointerDown({ ...start, x: connected.end.x, y: connected.end.y });
    fixture.interaction.pointerMove({ ...start, x: 500, y: 500 });
    fixture.interaction.pointerUp(start.pointerId);
    expect(fixture.store.get(selectedLine.id)?.element).toMatchObject({ endConnection: null });
  });
});

describe("active editor multi-selection frame", () => {
  it("keeps its rotated box after release and restores it through undo and redo", () => {
    const first = rectangle();
    const second = {
      ...storeRectangle("00000000-0000-4000-8000-000000000099", 500, 350),
      height: first.height,
      pivot: { x: 600, y: 420 },
    };
    const selection = new Set([first.id, second.id]);
    const fixture = harness([first, second], 1, selection);
    const selected = [first, second].map((element) => ({
      bounds: calculateElementBounds(element),
      element,
    }));
    const initial = fixture.selectionFrames.current(selected)!;
    const handle = layoutSelectionHandles(selected, { frame: initial, zoom: 1 }).find(
      ({ kind }) => kind === "rotate",
    );
    if (handle?.kind !== "rotate") throw new Error("Expected a rotate handle.");
    const center = {
      x: (initial.points[0].x + initial.points[2].x) / 2,
      y: (initial.points[0].y + initial.points[2].y) / 2,
    };
    const pointerId = 31;
    expect(
      fixture.interaction.pointerDown({ ...handle.point, pointerId, pointerType: "mouse" }),
    ).toBe(true);
    expect(
      fixture.interaction.pointerMove({
        ...rotatePointClockwise(handle.point, center, 30),
        pointerId,
        pointerType: "mouse",
      }),
    ).toBe(true);
    const previewPath = fixture.overlays[fixture.overlays.length - 2];
    expect(fixture.interaction.pointerUp(pointerId)).toBe(true);

    expect(fixture.beginPreviewCommit).toHaveBeenCalledOnce();
    expect(fixture.armPreviewCommit).toHaveBeenCalledWith([first.id, second.id]);
    expect(fixture.cancelPreviewCommit).not.toHaveBeenCalled();
    expect(fixture.armPreviewCommit.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.clearPreviewTransforms.mock.invocationCallOrder[0]!,
    );
    expect(fixture.overlays[fixture.overlays.length - 2]).toBe(previewPath);
    expect(fixture.selectionFrames.current(selected)?.rotation).toBe(30);
    expect(fixture.history.undo()).toBe(true);
    expect(fixture.selectionFrames.current(selected)).toEqual(initial);
    expect(fixture.history.redo()).toBe(true);
    expect(fixture.selectionFrames.current(selected)?.rotation).toBe(30);
  });
});

describe("active editor endpoint straightening", () => {
  it("shows the endpoint chord only for a straight preview and removes bend on release", () => {
    const curved = editLinearBend(line(), { x: 30, y: 40 });
    if (curved.kind !== "line") throw new TypeError("Expected a curved line.");
    const fixture = harness([curved], 1);
    const start = {
      pointerId: 27,
      pointerType: "mouse" as const,
      x: curved.end.x,
      y: curved.end.y,
    };

    expect(fixture.interaction.pointerDown(start)).toBe(true);
    expect(fixture.interaction.pointerMove({ ...start, x: 10, y: 90 })).toBe(true);
    expect(fixture.overlays[fixture.overlays.length - 1]).toBeNull();

    expect(fixture.interaction.pointerMove({ ...start, x: 50, y: 70 })).toBe(true);
    expect(fixture.overlays[fixture.overlays.length - 1]).toBe(
      "M -3.3128047094054995 -9.96920706410825 L 63.3128047094055 89.96920706410825",
    );
    expect(fixture.store.get(curved.id)?.element).toMatchObject({ bend: { x: 30, y: 40 } });

    expect(fixture.interaction.pointerMove({ ...start, x: 50, y: 170 })).toBe(true);
    expect(fixture.overlays[fixture.overlays.length - 1]).toBeNull();
    expect(fixture.store.get(curved.id)?.element).toMatchObject({ bend: { x: 30, y: 40 } });

    expect(fixture.interaction.pointerMove({ ...start, x: 50, y: 70 })).toBe(true);
    expect(fixture.interaction.pointerUp(start.pointerId)).toBe(true);
    expect(fixture.store.get(curved.id)?.element).toMatchObject({
      bend: null,
      end: { x: 50, y: 70 },
    });
  });
});

function harness(
  elements: readonly InkElementV1[],
  zoom: number,
  selection: ReadonlySet<string> = new Set([elements[elements.length - 1]!.id]),
) {
  const store = new ElementStore(elements);
  const model = {
    commitBandOrder: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    mutationAvailability: "available",
    removeElements: vi.fn(),
    replaceElements: (replacements: readonly InkElementV1[]) => store.replaceMany(replacements),
    setGestureActive: vi.fn(),
    store,
  } as unknown as EditableDocumentModel;
  const overlays: Array<string | null> = [];
  const layout = {
    begin: vi.fn(),
    finish: vi.fn(),
    updateBottom: vi.fn(),
  };
  const sceneStore = new ElementSceneStore(store);
  const history = new ActiveEditorHistory(model);
  const selectionFrames = new SelectionFrameSession();
  const armPreviewCommit = vi.fn(() => true);
  const cancelPreviewCommit = vi.fn();
  const beginPreviewCommit = vi.fn(() => ({ arm: armPreviewCommit, cancel: cancelPreviewCommit }));
  const clearPreviewTransforms = vi.fn();
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: immediateFrameScheduler(),
    history,
    layout,
    model,
    pageToScreen: (point) => point,
    preparedHistory: {} as PreparedElementHistory,
    renderer: {
      beginPreviewCommit,
      clearElementPreviews: vi.fn(),
      clearPreviewTransforms,
      flushPointerFeedbackFrame: vi.fn(),
      setElementPreviews: vi.fn(),
      setPreviewTransform: vi.fn(),
      setSelectionOverlayPath: (path) => overlays.push(path),
      setSnapMarkerPath: (path) => overlays.push(path),
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore,
    selection: () => selection,
    selectionFrames,
    zoom: () => zoom,
  });
  return {
    armPreviewCommit,
    beginPreviewCommit,
    cancelPreviewCommit,
    clearPreviewTransforms,
    history,
    interaction,
    layout,
    overlays,
    selectionFrames,
    store,
  };
}
