import { describe, expect, it, vi } from "vitest";
import {
  TextReflowSession,
  type TextReflow,
} from "../../../../../src/editor/selection/transform/text-reflow-session";
import { SelectionHandleSession } from "../../../../../src/editor/selection/handle-session";
import { ElementStore } from "../../../../../src/domain/store/public";
import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import { selectionOverlayGeometry } from "../../../../../src/editor/selection/overlay-geometry";
import type { InkElementV1, TextElementV2 } from "../../../../../src/domain/schema/public";
import { textElement } from "../../../domain/schema/fixtures";

import { deferredTextReflow } from "../../../../fixtures/editor/text-handle-session";

function reflowFixture() {
  const deferred = deferredTextReflow();
  const ready = vi.fn();
  const text = textElement();
  const session = new TextReflowSession(text, deferred.reflow, ready);
  return { deferred, ready, text, session };
}

function widthHandleSession(
  text: TextElementV2,
  reflowText: TextReflow,
  onPreviewReady?: () => void,
) {
  return new SelectionHandleSession({
    action: { kind: "scale", position: "middle-right", anchor: { x: 100, y: 125 }, rotation: 0 },
    elements: [text],
    startPointer: { x: 200, y: 125 },
    planner: new ElementStore([text]),
    reflowText,
    ...(onPreviewReady === undefined ? {} : { onPreviewReady }),
  });
}

function wrappedText(text: TextElementV2, height = 80): TextElementV2 {
  return {
    ...text,
    height,
    pivot: { x: text.x + text.width / 2, y: text.y + height / 2 },
    layout: {
      version: 1,
      lines: [
        {
          x: 0,
          y: 0,
          width: 30,
          height: 20,
          baseline: 15,
          runs: [{ text: "Hel", start: 0, end: 3, x: 0, width: 30 }],
        },
        {
          x: 0,
          y: 20,
          width: 20,
          height: 20,
          baseline: 15,
          runs: [{ text: "lo", start: 3, end: 5, x: 0, width: 20 }],
        },
      ],
    },
  };
}

function assertReflowedBox(reflowed: InkElementV1): void {
  const geometry = selectionOverlayGeometry(
    [{ element: reflowed, bounds: calculateElementBounds(reflowed) }],
    1,
  )!;
  expect(geometry.outline).toEqual({
    kind: "polygon",
    points: [
      { x: 100, y: 100 },
      { x: 150, y: 100 },
      { x: 150, y: 180 },
      { x: 100, y: 180 },
    ],
  });
  expect(geometry.handles).toContainEqual({
    kind: "scale",
    position: "middle-right",
    point: { x: 150, y: 140 },
  });
}

describe("text width reflow reversal", () => {
  it("restores the prepared starting field immediately when a width drag is reversed", async () => {
    const { deferred, ready, text, session } = reflowFixture();
    session.request({ ...text, width: 50 });
    const pending = deferred.requests[0]!;
    session.request(text);
    expect(pending.signal.aborted).toBe(true);
    expect(session.current).toBe(text);
    pending.resolve(wrappedText(pending.element));
    expect(await session.settle()).toBe(text);
    expect(deferred.requests).toHaveLength(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it("cancels obsolete width work when the handle returns to its starting point", async () => {
    const text = textElement();
    const deferred = deferredTextReflow();
    const ready = vi.fn();
    const session = widthHandleSession(text, deferred.reflow, ready);
    session.update({ x: 150, y: 125 });
    const pending = deferred.requests[0]!;
    const restored = session.update({ x: 200, y: 125 });
    expect(pending.signal.aborted).toBe(true);
    expect(restored.exactElements).toEqual([]);
    expect(session.prepareCommit()).toEqual({ status: "noop" });
    pending.resolve(wrappedText(pending.element));
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(deferred.requests).toHaveLength(1);
  });
});

describe("text width reflow", () => {
  it("coalesces obsolete widths without aborting useful layout work and publishes only the latest result", async () => {
    const { deferred, ready, text, session } = reflowFixture();
    session.request({ ...text, width: 70 });
    session.request({ ...text, width: 60 });
    session.request({ ...text, width: 50 });
    expect(deferred.requests).toHaveLength(1);
    expect(deferred.requests[0]!.signal.aborted).toBe(false);
    deferred.requests[0]!.resolve(wrappedText(deferred.requests[0]!.element));
    await Promise.resolve();
    expect(session.current).toBe(text);
    expect(ready).not.toHaveBeenCalled();
    expect(deferred.requests).toHaveLength(2);
    expect(deferred.requests[1]!.element.width).toBe(50);
    deferred.requests[1]!.resolve(wrappedText(deferred.requests[1]!.element));
    expect((await session.settle())?.width).toBe(50);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(session.current.layout.lines).toHaveLength(2);
  });

  it("reuses completed work when reversing to the running width without publishing an intervening width", async () => {
    const { deferred, ready, text, session } = reflowFixture();
    const target = { ...text, width: 70 };
    session.request(target);
    session.request({ ...text, width: 50 });
    session.request(target);
    const running = deferred.requests[0]!;
    expect(running.signal.aborted).toBe(false);
    running.resolve(wrappedText(running.element));
    expect((await session.settle())?.width).toBe(70);
    expect(deferred.requests).toHaveLength(1);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("shows unscaled glyphs while pending and commits the completed content height without another layout", async () => {
    const text = textElement();
    const deferred = deferredTextReflow();
    const session = widthHandleSession(text, deferred.reflow);
    const pending = session.update({ x: 150, y: 125 });
    expect(pending.transform).toBeNull();
    expect(pending.exactElements[0]).toMatchObject({ width: 100, style: { fontSize: 16.5 } });
    deferred.requests[0]!.resolve(wrappedText(deferred.requests[0]!.element));
    const result = await session.prepareCommitTimeSliced({
      shouldYield: () => false,
      yieldControl: () => Promise.resolve(),
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a completed reflow commit.");
    expect(result.replacements[0]).toMatchObject({
      x: 100,
      y: 100,
      width: 50,
      height: 80,
      pivot: { x: 125, y: 140 },
      style: { fontSize: 16.5 },
    });
    assertReflowedBox(result.replacements[0]!);
    expect(deferred.requests).toHaveLength(1);
  });

  it("discards in-flight work on cancellation and does not reflow movement", async () => {
    const text = textElement();
    const deferred = deferredTextReflow();
    const reflow = new TextReflowSession(text, deferred.reflow, vi.fn());
    reflow.request({ ...text, width: 50 });
    reflow.dispose();
    expect(deferred.requests[0]!.signal.aborted).toBe(true);
    deferred.requests[0]!.resolve(wrappedText(deferred.requests[0]!.element));
    expect(await reflow.settle()).toBeNull();
    const callback = vi.fn<TextReflow>();
    const session = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [text],
      startPointer: { x: 200, y: 150 },
      planner: new ElementStore([text]),
      reflowText: callback,
    });
    session.update({ x: 250, y: 175 });
    await session.prepareCommitTimeSliced({
      shouldYield: () => false,
      yieldControl: () => Promise.resolve(),
    });
    expect(callback).not.toHaveBeenCalled();
  });
});
