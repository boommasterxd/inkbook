import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import { buildElementPathParts } from "../../../../../../src/domain/geometry/public";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { CreationPreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { CoalescedPointerInput } from "../../../../../../src/obsidian/embeds/active-editor/input/coalesced-input";
import type { GesturePreview } from "../../../../../../src/editor/gestures/public";
import {
  activeEditorStoreHistory,
  creationPreviewRenderer,
} from "../../../../../fixtures/obsidian/active-editor";
import { ManualFrameScheduler } from "../../../../../fixtures/obsidian/manual-frame-scheduler";
import { createWorkerSnapshot } from "../../../../../fixtures/persistence/worker-snapshot";
import { parseInkbookDocumentForTest } from "../../../../../fixtures/persistence/parse-document";
import { serializeInkbookDocument } from "../../../../../../src/persistence/serialization/public";

describe("active editor live stroke preview", () => {
  it("commits a coalesced pen stroke and restores the same stroke after undo and redo", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const { commitLiveStroke, history, input, routed, store, updateLiveStroke } =
      createLiveStrokeHarness(id);
    input.dispatch(
      coalescedEvent([
        pointerEvent(20, 20, 0.6, 1),
        pointerEvent(30, 30, 0.7, 2),
        pointerEvent(40, 40, 0.8, 3),
      ]),
    );
    expect(updateLiveStroke).toHaveBeenCalledTimes(2);
    expect(routed.commit()).toBe(true);
    expect(store.size).toBe(1);
    const stroke = store.get(id)?.element;
    if (stroke?.kind !== "stroke") throw new Error("Expected a committed pen stroke.");
    expect(commitLiveStroke).toHaveBeenCalledOnce();

    const committedStroke = structuredClone(stroke);
    expect(history.undo()).toBe(true);
    expect(store.size).toBe(0);
    expect(history.redo()).toBe(true);
    expect(store.size).toBe(1);
    expect(store.get(id)?.element).toEqual(committedStroke);
  });
});

describe("active editor highlighter durability", () => {
  it("flushes a constant-pressure highlighter through commit and durable round trip", async () => {
    const id = "00000000-0000-4000-8000-000000000025";
    const scheduler = new ManualFrameScheduler();
    const { input, routed, store, updateLiveStroke } = createLiveStrokeHarness(
      id,
      scheduler,
      "highlighter",
    );
    input.dispatch(
      coalescedEvent(
        Array.from({ length: 48 }, (_, index) =>
          pointerEvent(11 + index, 10 + (index % 3), index % 2 === 0 ? 0.25 : 0.75, index + 1),
        ),
      ),
    );
    expect(updateLiveStroke).toHaveBeenCalledOnce();
    expect(routed.commit()).toBe(true);
    const element = store.get(id)?.element;
    if (element?.kind !== "stroke") throw new Error("Expected a committed highlighter.");
    expect(element.tool).toBe("highlighter");
    expect(element.points).toHaveLength(49 * 3);
    expect(element.points.slice(-3)).toEqual([58, 12, 0]);
    expect(element.points.filter((_, index) => index % 3 === 2)).toEqual(Array<number>(49).fill(0));
    const canonical = { ...element, points: [...element.points] };
    const legacy = {
      ...element,
      points: element.points.map((value, index) => (index % 3 === 2 ? 0.75 : value)),
    };
    expect(buildElementPathParts(canonical)).toEqual(buildElementPathParts(legacy));
    for (const stroke of [canonical, legacy]) {
      const saved = serializeInkbookDocument(createWorkerSnapshot([stroke]));
      if (!saved.ok) throw new Error(saved.error.code);
      const parsed = await parseInkbookDocumentForTest(saved.value.svg);
      if (!parsed.ok) throw new Error(parsed.error.code);
      expect(parsed.value.snapshot.elements[0]).toEqual(stroke);
    }
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe("active editor live stroke limits", () => {
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
});

function createLiveStrokeHarness(
  identity: string,
  frameScheduler?: ManualFrameScheduler,
  tool: "draw" | "highlighter" = "draw",
) {
  const store = new ElementStore();
  const history = activeEditorStoreHistory(store);
  const commitLiveStroke = vi.fn();
  const updateLiveStroke = vi.fn();
  const preview = new CreationPreview({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    identity: { createdAt: 1, id: identity },
    renderer: creationPreviewRenderer({
      commitLiveStroke,
      updateLiveStroke,
    }),
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType: "pen", pressure: 0.5, x: 10, y: 10 },
      tool,
    },
  });
  let routed: GesturePreview = preview;
  const input = createCoalescedInput((pointer) => routed.update(pointer), frameScheduler);
  routed = input.wrap(preview);
  return { commitLiveStroke, history, input, routed, store, updateLiveStroke };
}

function coalescedHarness(
  dispatchMove: (pointer: Parameters<GesturePreview["update"]>[0]) => void,
) {
  return createCoalescedInput(dispatchMove);
}

function createCoalescedInput(
  dispatchMove: (pointer: Parameters<GesturePreview["update"]>[0]) => void,
  frameScheduler?: ManualFrameScheduler,
) {
  return new CoalescedPointerInput({
    dispatchMove,
    ...(frameScheduler === undefined ? {} : { frameScheduler }),
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
  const dispatched = samples[samples.length - 1] ?? pointerEvent(0, 0, 0.5, 0);
  return {
    ...dispatched,
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
