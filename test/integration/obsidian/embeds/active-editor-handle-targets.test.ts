import { describe, expect, it, vi } from "vitest";

import {
  calculateElementBounds,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  editLinearBend,
  layoutSelectionHandles,
  oppositeElementHandlePoint,
} from "../../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
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

    expect(fixture.interaction.pointerDown(pointer)).toBe(true);
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
    expect(fixture.store.get(element.id)?.element).toHaveProperty("width", 200.98);
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
    expect(rotation.overlays[rotation.overlays.length - 1]).toBe("M 64 170 L 364 170");
    rotation.interaction.cancel(24);

    const linear = line();
    const bend = harness([linear], 1);
    bend.interaction.pointerDown({ pointerId: 25, pointerType: "touch", x: 30, y: 30 });
    bend.interaction.pointerMove({ pointerId: 25, pointerType: "touch", x: 32, y: 32 });
    expect(bend.overlays[bend.overlays.length - 1]).toContain(
      "M -35.25483399593904 -35.25483399593904 L 95.25483399593904 95.25483399593904",
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
    expect(distance(guide.start, opposite)).toBeCloseTo(64, 8);
    expect(distance(guide.end, rotatedHandle)).toBeCloseTo(64, 8);
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
    expect(fixture.overlays[fixture.overlays.length - 1]).toContain("M 92 100 L 108 100");
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
      "M -25.500812558414665 -43.251218837622 L 85.50081255841467 123.25121883762199",
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

function harness(elements: readonly InkElementV1[], zoom: number) {
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
  const interaction = new ActiveEditorHandleInteraction({
    history: new ActiveEditorHistory(model),
    layout,
    model,
    pageToScreen: (point) => point,
    preparedHistory: {} as PreparedElementHistory,
    renderer: {
      clearElementPreviews: vi.fn(),
      clearPreviewTransforms: vi.fn(),
      setElementPreviews: vi.fn(),
      setPreviewTransform: vi.fn(),
      setSelectionOverlayPath: (path) => overlays.push(path),
      setSnapMarkerPath: (path) => overlays.push(path),
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore,
    selection: () => new Set([elements[elements.length - 1]!.id]),
    zoom: () => zoom,
  });
  return { interaction, layout, overlays, store };
}
