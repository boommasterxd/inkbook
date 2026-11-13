import { describe, expect, it, vi } from "vitest";
import { preserveTextReflowOrigin } from "../../../../src/domain/geometry/text-reflow";
import { pointDistance } from "../../../../src/domain/geometry/public";
import type { BoxAnchorV1, TextElementV2 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/handle-session";
import {
  oppositeBoxAnchor,
  oppositeElementHandlePoint,
} from "../../../../src/editor/selection/handles";
import { resolveShapeAnchor } from "../../../../src/domain/geometry/anchors";
import { textElement } from "../../domain/schema/fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

function fixture(rotation: number, position: BoxAnchorV1 = "bottom-right") {
  const source = textElement();
  const text = {
    ...source,
    rotation,
    height: 60,
    pivot: { x: 150, y: 130 },
    style: { ...source.style, fontSize: 48 },
    layout: {
      version: 1 as const,
      lines: [{ ...source.layout.lines[0]!, height: 60, baseline: 48 }],
    },
  };
  const anchor = oppositeElementHandlePoint(text, position);
  const start = resolveShapeAnchor(text, { kind: "box", position })!;
  const pointer = {
    x: anchor.x + (start.x - anchor.x) * 1.5,
    y: anchor.y + (start.y - anchor.y) * 1.5,
  };
  return { text, anchor, start, pointer, position };
}

function nativeMetrics(element: TextElementV2): TextElementV2 {
  return preserveTextReflowOrigin(element, {
    ...element,
    height: 94,
    layout: { version: 1, lines: [{ ...element.layout.lines[0]!, height: 94, baseline: 73 }] },
  });
}

describe("native metrics after text corner scale", () => {
  it.each([0, 30, 90])(
    "reflows only at commit and preserves the opposite anchor at %s degrees",
    async (rotation) => {
      for (const position of ["bottom-right", "top-left"] as const) {
        const { text, anchor, start, pointer } = fixture(rotation, position);
        const reflowText = vi.fn(async (value: TextElementV2) => nativeMetrics(value));
        const session = new SelectionHandleSession({
          action: { kind: "scale", position, anchor, rotation },
          elements: [text],
          planner: new ElementStore([text]),
          startPointer: start,
          reflowText,
        });
        for (let sample = 1; sample <= 20; sample += 1)
          session.update({
            x: start.x + ((pointer.x - start.x) * sample) / 20,
            y: start.y + ((pointer.y - start.y) * sample) / 20,
          });
        expect(reflowText).not.toHaveBeenCalled();
        expect(session.preview.transform?.kind).toBe("scale");
        expect(session.prepareCommit().status).toBe("time-sliced-required");
        const result = await session.prepareCommitTimeSliced(scheduler);
        if (result.status !== "ready")
          throw new Error("Expected native metrics for corner commit.");
        const resized = result.replacements[0]!;
        if (resized.kind !== "text") throw new Error("Expected a text replacement.");
        expect(resized).toMatchObject({
          width: 150,
          height: 94,
          style: { fontSize: 72 },
          layout: { lines: [{ baseline: 73 }] },
        });
        expect(reflowText).toHaveBeenCalledTimes(1);
        const opposite = resolveShapeAnchor(resized, {
          kind: "box",
          position: oppositeBoxAnchor(position),
        })!;
        expect(pointDistance(opposite, anchor)).toBeLessThanOrEqual(0.003);
      }
    },
  );

  it("aborts stale native preparation after a new pointer sample", async () => {
    const { text, anchor, start, pointer, position } = fixture(0);
    let pending:
      | { element: TextElementV2; signal: AbortSignal; resolve(value: TextElementV2): void }
      | undefined;
    const session = new SelectionHandleSession({
      action: { kind: "scale", position, anchor, rotation: 0 },
      elements: [text],
      planner: new ElementStore([text]),
      startPointer: start,
      reflowText: (element, signal) =>
        new Promise((resolve) => {
          pending = { element, signal, resolve };
        }),
    });
    session.update(pointer);
    const preparation = session.prepareCommitTimeSliced(scheduler);
    for (let step = 0; step < 10 && pending === undefined; step += 1) await Promise.resolve();
    if (pending === undefined) throw new Error("Expected pending native text preparation.");
    session.update({ x: pointer.x + 1, y: pointer.y });
    expect(pending.signal.aborted).toBe(true);
    pending.resolve(nativeMetrics(pending.element));
    expect(await preparation).toEqual({ status: "cancelled" });
  });
});
