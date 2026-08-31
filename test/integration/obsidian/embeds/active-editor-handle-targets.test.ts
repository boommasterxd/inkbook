import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { layoutSelectionHandles } from "../../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { connectedLine, rectangle as storeRectangle } from "../../../unit/domain/store/fixtures";

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
    const radius = Math.hypot(
      rotateHandle.point.x - shape.pivot.x,
      rotateHandle.point.y - shape.pivot.y,
    );
    expect(rotation.overlays[rotation.overlays.length - 1]).toContain(
      `M ${String(shape.pivot.x - radius)} ${String(shape.pivot.y)} L ${String(shape.pivot.x + radius)} ${String(shape.pivot.y)}`,
    );
    expect(rotation.overlays[rotation.overlays.length - 1]).not.toContain(
      `M ${String(shape.pivot.x + radius - 8)} ${String(shape.pivot.y)} L`,
    );
    rotation.interaction.cancel(24);

    const linear = line();
    const bend = harness([linear], 1);
    bend.interaction.pointerDown({ pointerId: 25, pointerType: "touch", x: 30, y: 30 });
    bend.interaction.pointerMove({ pointerId: 25, pointerType: "touch", x: 32, y: 32 });
    expect(bend.overlays[bend.overlays.length - 1]).toContain("M 10 10 L 50 50");
    bend.interaction.cancel(25);
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
  const sceneStore = new ElementSceneStore(store);
  const interaction = new ActiveEditorHandleInteraction({
    history: new ActiveEditorHistory(model),
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
  return { interaction, overlays, store };
}
