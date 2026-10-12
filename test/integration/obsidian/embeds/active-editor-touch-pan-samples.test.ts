import { describe, expect, it, vi } from "vitest";

import { createInputState } from "../../../../src/editor/input/index";
import {
  beginTouchPan as beginPan,
  expectCancelledTouchPan,
  touchPanBatch as batch,
  touchPanEvent as event,
  touchPanHarness as setup,
} from "../../../fixtures/obsidian/touch-pan-samples";

describe("touch pan velocity samples at the controller boundary", () => {
  it("retains identical ordered velocity samples across dispatch partitions", () => {
    const segmented = setup();
    const coalesced = setup();
    const samples = [event(160, 16), event(180, 24), event(210, 32)];
    beginPan(segmented);
    beginPan(coalesced);
    segmented.dispatch.mockClear();
    coalesced.dispatch.mockClear();
    segmented.screenPointer.mockClear();
    coalesced.screenPointer.mockClear();

    for (const sample of samples) segmented.pointer.handlePointerMove(sample);
    const getCoalescedEvents = vi.fn(() => samples);
    coalesced.pointer.handlePointerMove(event(210, 32, { getCoalescedEvents }));
    const projected = coalesced.screenPointer.mock.calls.length;
    segmented.pointer.handlePointerUp(event(210, 40));
    coalesced.pointer.handlePointerUp(event(210, 40));

    expect(coalesced.recordTouchPan.mock.calls).toEqual(segmented.recordTouchPan.mock.calls);
    expect(coalesced.recordTouchPan.mock.calls).toEqual([
      [0, 0],
      [30, 8],
      [10, 16],
      [20, 24],
      [30, 32],
    ]);
    expect(coalesced.releaseTouchPan).toHaveBeenCalledExactlyOnceWith(40);
    expect(segmented.releaseTouchPan).toHaveBeenCalledExactlyOnceWith(40);
    expect(getCoalescedEvents).toHaveBeenCalledOnce();
    expect(projected).toBe(5);
    expect(
      coalesced.dispatch.mock.calls.filter(([action]) => action.type === "pointer-move"),
    ).toHaveLength(2);
    expect(
      segmented.dispatch.mock.calls.filter(([action]) => action.type === "pointer-move"),
    ).toHaveLength(4);
    expect(coalesced.effects.filter((effect) => effect.type === "pan-page").slice(-2)).toEqual([
      { type: "pan-page", screenDeltaX: 60 },
      { type: "pan-page", screenDeltaX: 0 },
    ]);
    expect(coalesced.controls.input.interaction).toBeUndefined();
  });

  it("keeps pending samples as baselines and includes real terminal motion and reversals", () => {
    const h = setup();
    h.pointer.handlePointerDown(event(120, 0));
    h.pointer.handlePointerMove(batch([event(121, 2), event(122, 4), event(124, 8)]));
    h.pointer.handlePointerMove(event(150, 16));
    h.pointer.handlePointerUp(batch([event(190, 24), event(210, 32), event(180, 40)]));

    expect(h.recordTouchPan.mock.calls).toEqual([
      [0, 0],
      [0, 2],
      [0, 4],
      [0, 8],
      [26, 16],
      [40, 24],
      [20, 32],
      [-30, 40],
    ]);
    expect(h.releaseTouchPan).toHaveBeenCalledExactlyOnceWith(40);
    expect(h.controls.input.interaction).toBeUndefined();
    expect(h.release).toHaveBeenCalledWith(1);
  });

  it.each(["move", "up"] as const)(
    "rejects an invalid %s batch before velocity or movement",
    (phase) => {
      const h = setup();
      beginPan(h);
      h.recordTouchPan.mockClear();
      h.dispatch.mockClear();
      const invalid = batch([event(160, 16), event(180, 24, { pressure: Number.NaN })]);

      if (phase === "move") h.pointer.handlePointerMove(invalid);
      else h.pointer.handlePointerUp(invalid);

      expectCancelledTouchPan(h);
    },
  );
});

describe("touch pan velocity ownership", () => {
  it("claims the complete initial horizontal batch while retaining an internal reversal", () => {
    const h = setup();
    h.pointer.handlePointerDown(event(120, 0));
    h.pointer.handlePointerMove(
      batch([event(124, 4), event(140, 8), event(135, 12), event(160, 16)]),
    );

    expect(h.controls.input.interaction?.phase).toBe("page-pan");
    expect(h.recordTouchPan.mock.calls).toEqual([
      [0, 0],
      [4, 4],
      [16, 8],
      [-5, 12],
      [25, 16],
    ]);
    expect(h.effects.filter((effect) => effect.type === "pan-page")).toEqual([
      { type: "pan-page", screenDeltaX: 40 },
    ]);
    h.pointer.handlePointerCancel(event(160, 24));
    expect(h.controls.input.interaction).toBeUndefined();
  });

  it("excludes foreign touches, pinch, native scroll, and drawing from pan velocity", () => {
    const h = setup();
    beginPan(h);
    h.recordTouchPan.mockClear();
    h.pointer.handlePointerMove(event(190, 16, { pointerId: 2 }));
    h.pointer.handlePointerUp(event(190, 24, { pointerId: 2 }));
    expect(h.recordTouchPan).not.toHaveBeenCalled();
    expect(h.releaseTouchPan).not.toHaveBeenCalled();
    h.pointer.handlePointerDown(event(180, 32, { pointerId: 2 }));
    expect(h.controls.input.interaction?.phase).toBe("pinch");
    h.pointer.handlePointerMove(event(200, 40));
    expect(h.recordTouchPan).not.toHaveBeenCalled();
    h.pointer.handlePointerCancel(event(200, 48));

    h.pointer.handlePointerDown(event(120, 56));
    h.recordTouchPan.mockClear();
    h.pointer.handlePointerMove(event(120, 64, { clientY: 150 }));
    expect(h.controls.input.interaction?.phase).toBe("note-scroll");
    h.pointer.handlePointerUp(event(120, 72, { clientY: 170 }));
    expect(h.recordTouchPan).not.toHaveBeenCalled();
    h.controls.input = createInputState({
      deviceFingerDrawingEnabled: true,
      toolbarFingerDrawingEnabled: true,
    });
    h.pointer.handlePointerDown(event(120, 80));
    expect(h.controls.input.interaction?.phase).toBe("tool-gesture");
    h.pointer.handlePointerMove(event(180, 88));
    h.pointer.handlePointerUp(event(180, 96));
    expect(h.recordTouchPan).not.toHaveBeenCalled();
    expect(h.releaseTouchPan).not.toHaveBeenCalled();
  });
});
