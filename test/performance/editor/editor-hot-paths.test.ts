import { afterEach, describe, expect, it, vi } from "vitest";

import { EraserSweep } from "../../../src/editor/gestures/public";
import { maximumStroke } from "./maximum-stroke-fixture";
import { createPassThroughMoveSession } from "./selection-session-fixture";

afterEach(() => vi.restoreAllMocks());

describe("editor gesture hot paths", () => {
  it("bounds maximum-stroke preview and eraser work independently of sweep length", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const strokes = Array.from({ length: 256 }, (_, index) => maximumStroke(index));
    const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
    const ids = strokes.map(({ id }) => id);

    let elementLookups = 0;
    const session = createPassThroughMoveSession(strokes, { x: -1_000, y: 0 });
    const preview = session.update({ x: 5_000, y: 0 });
    const eraser = new EraserSweep(
      { x: -1_000, y: 0 },
      4,
      (() => {
        let queryCount = 0;
        return {
          getElement: (id) => {
            elementLookups += 1;
            return byId.get(id);
          },
          query: (_bounds, sink) => {
            if (queryCount++ === 1) for (const id of ids) sink.add(id);
          },
        };
      })(),
      { clearCandidateFade: () => undefined, setCandidateFade: () => undefined },
    );
    eraser.update({ x: 5_000, y: 0 });
    let updates = 0;
    while (eraser.candidateCount < strokes.length) {
      expect(updates++).toBeLessThan(100);
      eraser.update({ x: 5_000, y: 0 });
    }
    expect(preview.exactPreviewTruncated).toBe(true);
    expect(eraser.candidateCount).toBe(256);
    expect(elementLookups).toBe(256);
    eraser.revert();
  });
});
