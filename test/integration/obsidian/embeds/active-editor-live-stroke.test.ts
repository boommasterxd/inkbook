import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../src/domain/store/public";
import { CreationPreview } from "../../../../src/obsidian/embeds/active-editor/creation-preview";
import { CoalescedPointerInput } from "../../../../src/obsidian/embeds/active-editor/coalesced-input";
import type { GesturePreview } from "../../../../src/editor/gestures/public";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { creationPreviewRenderer } from "../../../fixtures/obsidian/active-editor";

describe("active editor live stroke preview", () => {
  it("consumes coalesced samples and commits the incremental stroke", () => {
    const { clearLiveStroke, input, preview, store, updateLiveStroke } = createLiveStrokeHarness(
      "00000000-0000-4000-8000-000000000001",
    );
    input.dispatch(
      coalescedEvent([
        pointerEvent(20, 20, 0.6, 1),
        pointerEvent(30, 30, 0.7, 2),
        pointerEvent(40, 40, 0.8, 3),
      ]),
    );
    expect(updateLiveStroke).toHaveBeenCalledTimes(2);
    expect(preview.commit()).toBe(true);
    expect(store.size).toBe(1);
    expect(store.get("00000000-0000-4000-8000-000000000001")?.element.kind).toBe("stroke");
    expect(clearLiveStroke).toHaveBeenCalledOnce();
  });

  it("uses real pen pressure and simulated mouse pressure", () => {
    const pen = createPressurePreview("00000000-0000-4000-8000-000000000021", "pen");
    pen.preview.update({ pointerId: 1, pointerType: "pen", pressure: 0.9, x: 110, y: 10 });
    pen.preview.commit();
    const penElement = pen.store.get("00000000-0000-4000-8000-000000000021")?.element;
    expect(penElement?.kind === "stroke" ? penElement.points[5] : undefined).toBe(0.9);

    const mouse = createPressurePreview("00000000-0000-4000-8000-000000000022", "mouse");
    mouse.preview.update({
      pointerId: 1,
      pointerType: "mouse",
      pressure: 0.9,
      x: 110,
      y: 10,
    });
    mouse.preview.commit();
    const mouseElement = mouse.store.get("00000000-0000-4000-8000-000000000022")?.element;
    expect(mouseElement?.kind === "stroke" ? mouseElement.points[2] : undefined).toBe(0.5);
    expect(mouseElement?.kind === "stroke" ? mouseElement.points[5] : undefined).toBe(0.425);
  });
});

describe("active editor live stroke limits", () => {
  it("commits when pointerup provides the 4097th retained sample", () => {
    const { input, preview, store } = createLiveStrokeHarness(
      "00000000-0000-4000-8000-000000000002",
    );

    const samples = Array.from({ length: 4096 }, (_, index) =>
      pointerEvent(11, index + 11, 0.5, index + 1),
    );
    expect(() => input.dispatch(coalescedEvent(samples))).not.toThrow();

    expect(preview.commit()).toBe(true);
    const element = store.get("00000000-0000-4000-8000-000000000002")?.element;
    expect(element?.kind).toBe("stroke");
    if (element?.kind !== "stroke") throw new Error("Expected a committed stroke.");
    expect(element.points).toHaveLength(4096 * 3);
    expect(element.points[element.points.length - 2]).toBe(4106);
  });

  it("accepts a complete maximum-size coalesced stylus batch", () => {
    const dispatchMove = vi.fn();
    const input = coalescedHarness(dispatchMove);
    const samples = Array.from({ length: 4096 }, (_, index) =>
      pointerEvent(index, index, 0.5, index),
    );

    expect(input.dispatch(coalescedEvent(samples))).toBe(true);
    expect(dispatchMove).toHaveBeenCalledOnce();
    expect(dispatchMove).toHaveBeenCalledWith(expect.objectContaining({ x: 4095, y: 4095 }));
  });

  it.each([
    ["foreign pointer", [pointerEvent(10, 10, 0.5, 1), pointerEvent(20, 20, 0.5, 2, 2)]],
    [
      "foreign pointer type",
      [pointerEvent(10, 10, 0.5, 1), pointerEvent(20, 20, 0.5, 2, 1, "mouse")],
    ],
    ["non-finite coordinate", [pointerEvent(10, 10, 0.5, 1), pointerEvent(Number.NaN, 20, 0.5, 2)]],
    [
      "oversized coordinate",
      [pointerEvent(10, 10, 0.5, 1), pointerEvent(1_000_000.001, 20, 0.5, 2)],
    ],
    [
      "non-finite pressure",
      [pointerEvent(10, 10, 0.5, 1), pointerEvent(20, 20, Number.POSITIVE_INFINITY, 2)],
    ],
    ["non-finite timestamp", [pointerEvent(10, 10, 0.5, 1), pointerEvent(20, 20, 0.5, Number.NaN)]],
    ["negative timestamp", [pointerEvent(10, 10, 0.5, 1), pointerEvent(20, 20, 0.5, -1)]],
    ["non-monotone timestamp", [pointerEvent(10, 10, 0.5, 2), pointerEvent(20, 20, 0.5, 1)]],
  ] as const)("rejects a coalesced batch containing a %s", (_label, samples) => {
    const dispatchMove = vi.fn();
    const input = coalescedHarness(dispatchMove);

    expect(input.dispatch(coalescedEvent(samples))).toBe(false);
    expect(dispatchMove).not.toHaveBeenCalled();
  });

  it("rejects oversized or throwing coalesced lists without dispatch or exceptions", () => {
    const dispatchMove = vi.fn();
    const input = coalescedHarness(dispatchMove);
    const oversized = Array.from({ length: 4097 }, (_, index) =>
      pointerEvent(index, index, 0.5, index),
    );
    const throwing = {
      ...pointerEvent(0, 0, 0.5, 0),
      getCoalescedEvents: () => {
        throw new Error("untrusted browser input");
      },
    } as unknown as PointerEvent;

    expect(input.dispatch(coalescedEvent(oversized))).toBe(false);
    expect(() => input.dispatch(throwing)).not.toThrow();
    expect(dispatchMove).not.toHaveBeenCalled();
  });
});

function createLiveStrokeHarness(identity: string) {
  const store = new ElementStore();
  const history = strokeHistory(store);
  const clearLiveStroke = vi.fn();
  const updateLiveStroke = vi.fn();
  const preview = new CreationPreview({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    identity: { createdAt: 1, id: identity },
    renderer: creationPreviewRenderer({
      clearLiveStroke,
      updateLiveStroke,
    }),
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType: "pen", pressure: 0.5, x: 10, y: 10 },
      tool: "draw",
    },
  });
  let routed: GesturePreview = preview;
  const input = createCoalescedInput((pointer) => routed.update(pointer));
  routed = input.wrap(preview);
  return { clearLiveStroke, input, preview, store, updateLiveStroke };
}

function createPressurePreview(identity: string, pointerType: "mouse" | "pen") {
  const store = new ElementStore();
  const history = strokeHistory(store);
  const preview = new CreationPreview({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    identity: { createdAt: 1, id: identity },
    renderer: creationPreviewRenderer(),
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType, pressure: 0.9, x: 10, y: 10 },
      tool: "draw",
    },
  });
  return { preview, store };
}

function strokeHistory(store: ElementStore): ActiveEditorHistory {
  return new ActiveEditorHistory({
    commitBandOrder: (order) => void store.reorderBands(order),
    commitElements: (elements) => void store.create(elements),
    commitPage: vi.fn(),
    removeElements: (ids) => void store.remove(ids),
    replaceElements: (elements) => void store.replaceMany(elements),
  });
}

function coalescedHarness(
  dispatchMove: (pointer: Parameters<GesturePreview["update"]>[0]) => void,
) {
  return createCoalescedInput(dispatchMove);
}

function createCoalescedInput(
  dispatchMove: (pointer: Parameters<GesturePreview["update"]>[0]) => void,
) {
  return new CoalescedPointerInput({
    dispatchMove,
    now: () => 4,
    project: (event) => ({
      pointerId: event.pointerId,
      pointerType: event.pointerType === "mouse" ? "mouse" : "pen",
      pressure: event.pressure,
      x: event.clientX,
      y: event.clientY,
    }),
  });
}

function coalescedEvent(samples: readonly PointerEvent[]): PointerEvent {
  return {
    ...pointerEvent(0, 0, 0.5, 0),
    getCoalescedEvents: () => samples,
  } as unknown as PointerEvent;
}

function pointerEvent(
  x: number,
  y: number,
  pressure: number,
  timeStamp: number,
  pointerId = 1,
  pointerType = "pen",
): PointerEvent {
  return {
    clientX: x,
    clientY: y,
    pointerId,
    pointerType,
    pressure,
    timeStamp,
  } as unknown as PointerEvent;
}
