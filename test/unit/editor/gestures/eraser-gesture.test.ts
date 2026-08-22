import { describe, expect, it, vi } from "vitest";

import type { BoxShapeElementV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import {
  EraserSweep,
  MAX_RETAINED_ERASER_SWEEPS,
  screenPixelsToPageUnits,
  sweepTouchesElement,
  type EraserQuerySink,
} from "../../../../src/editor/gestures/public";
import { indexedStroke } from "../../../fixtures/editor/stroke";

const scheduler = {
  isCancelled: () => false,
  shouldYield: () => false,
  yieldControl: async () => undefined,
};

function addIds(sink: EraserQuerySink, ids: readonly string[]): void {
  for (const id of ids) sink.add(id);
}

const rectangle: BoxShapeElementV1 = {
  id: "shape",
  kind: "rectangle",
  createdAt: 1,
  rotation: 0,
  pivot: { x: 50, y: 50 },
  x: 40,
  y: 40,
  width: 20,
  height: 20,
  style: {
    outlineColor: { type: "theme-text" },
    outlineWidth: 2,
    outlineOpacity: 1,
    outlineStyle: "solid",
    fillColor: null,
    fillOpacity: 0,
  },
};

describe("screen-relative gesture distances", () => {
  it("converts CSS pixels into zoom-correct page units", () => {
    expect(screenPixelsToPageUnits(24, 2)).toBe(12);
    expect(screenPixelsToPageUnits(24, 0.5)).toBe(48);
    expect(() => screenPixelsToPageUnits(-1, 1)).toThrow(RangeError);
    expect(() => screenPixelsToPageUnits(24, 0)).toThrow(RangeError);
  });
});

describe("eraser sweep", () => {
  it("detects a thin element crossed between pointer samples", () => {
    expect(sweepTouchesElement({ x: 0, y: 50 }, { x: 100, y: 50 }, 4, rectangle)).toBe(true);
  });

  it("keeps candidates in the model until one atomic removal commit", async () => {
    const setFade = vi.fn();
    const clearFade = vi.fn();
    const sweep = new EraserSweep(
      { x: 0, y: 50 },
      4,
      { query: (_bounds, sink) => sink.add("shape"), getElement: () => rectangle },
      { setCandidateFade: setFade, clearCandidateFade: clearFade },
    );
    sweep.update({ x: 100, y: 50 });
    const remove = vi.fn(() => true);
    await expect(sweep.commit(remove, scheduler)).resolves.toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(clearFade).toHaveBeenCalledOnce();
  });

  it("uses the analytic capsule for long strokes without gaps or parallel false positives", () => {
    const stroke: StrokeElementV1 = {
      createdAt: 2,
      id: "00000000-0000-4000-8000-000000000002",
      kind: "stroke",
      pivot: { x: 50, y: 50 },
      points: [0, 50, 0.5, 100, 50, 0.5],
      rotation: 0,
      style: {
        color: { type: "theme-text" },
        opacity: 1,
        pressureEnabled: true,
        smoothing: 0.5,
        width: 2,
      },
      tool: "pen",
    };

    expect(sweepTouchesElement({ x: 50, y: 0 }, { x: 50, y: 100 }, 1, stroke)).toBe(true);
    expect(sweepTouchesElement({ x: 0, y: 53 }, { x: 100, y: 53 }, 1, stroke)).toBe(false);
  });

  it("honors rotation, fills, hollow ellipse interiors, and table dividers", () => {
    const rotated = { ...rectangle, rotation: 90 };
    expect(sweepTouchesElement({ x: 49, y: 20 }, { x: 49, y: 80 }, 1, rotated)).toBe(true);

    const filled = {
      ...rectangle,
      style: { ...rectangle.style, fillColor: { type: "theme-text" as const }, fillOpacity: 1 },
    };
    expect(sweepTouchesElement({ x: 45, y: 45 }, { x: 55, y: 55 }, 1, filled)).toBe(true);

    const hollowEllipse = { ...rectangle, kind: "ellipse" as const };
    expect(sweepTouchesElement({ x: 48, y: 50 }, { x: 52, y: 50 }, 1, hollowEllipse)).toBe(false);
    expect(sweepTouchesElement({ x: 20, y: 50 }, { x: 80, y: 50 }, 1, hollowEllipse)).toBe(true);

    const table = {
      columns: 3,
      columnWidth: 20,
      createdAt: 3,
      headerHeight: 10,
      height: 40,
      id: "00000000-0000-4000-8000-000000000003",
      kind: "table" as const,
      pivot: { x: 30, y: 20 },
      rotation: 0,
      style: rectangle.style,
      x: 0,
      y: 0,
    };
    expect(sweepTouchesElement({ x: 20, y: 15 }, { x: 20, y: 35 }, 1, table)).toBe(true);
  });
});

describe("ellipse eraser intersection", () => {
  it("erases visible ellipse fills while preserving transparent interiors", () => {
    const ellipse = { ...rectangle, kind: "ellipse" as const };
    const visibleFill = {
      ...ellipse,
      style: {
        ...ellipse.style,
        fillColor: { type: "theme-text" as const },
        fillOpacity: 0.25,
      },
    };
    const transparentFill = {
      ...visibleFill,
      style: { ...visibleFill.style, fillOpacity: 0 },
    };
    const colorlessFill = {
      ...visibleFill,
      style: { ...visibleFill.style, fillColor: null, fillOpacity: 1 },
    };

    expect(sweepTouchesElement({ x: 48, y: 50 }, { x: 52, y: 50 }, 0, visibleFill)).toBe(true);
    expect(sweepTouchesElement({ x: 48, y: 50 }, { x: 52, y: 50 }, 0, transparentFill)).toBe(false);
    expect(sweepTouchesElement({ x: 48, y: 50 }, { x: 52, y: 50 }, 0, colorlessFill)).toBe(false);
  });

  it("tests rotated ellipse fills and exact hollow-outline boundaries", () => {
    const rotatedFilledEllipse = {
      ...rectangle,
      height: 20,
      kind: "ellipse" as const,
      rotation: 90,
      style: {
        ...rectangle.style,
        fillColor: { type: "theme-text" as const },
        fillOpacity: 1,
      },
      width: 40,
      x: 30,
    };
    const hollowEllipse = {
      ...rectangle,
      kind: "ellipse" as const,
    };

    expect(sweepTouchesElement({ x: 50, y: 68 }, { x: 50, y: 68 }, 0, rotatedFilledEllipse)).toBe(
      true,
    );
    expect(sweepTouchesElement({ x: 59, y: 50 }, { x: 59, y: 50 }, 0, hollowEllipse)).toBe(true);
    expect(sweepTouchesElement({ x: 61, y: 50 }, { x: 61, y: 50 }, 0, hollowEllipse)).toBe(true);
    expect(sweepTouchesElement({ x: 61.01, y: 50 }, { x: 61.01, y: 50 }, 0, hollowEllipse)).toBe(
      false,
    );
  });
});

describe("resumable eraser work", () => {
  it("retains exact work for a later sweep while an earlier check is paused", async () => {
    const stroke = createLongStroke("paused-stroke", 20_000);
    let queryCount = 0;
    const sweep = new EraserSweep(
      { x: 0, y: 0 },
      4,
      {
        getElement: () => stroke,
        query: (_bounds, sink) => {
          if (queryCount++ !== 0) sink.add(stroke.id);
        },
      },
      { clearCandidateFade: () => undefined, setCandidateFade: () => undefined },
    );
    sweep.update({ x: 0, y: 0 });
    sweep.update({ x: 100, y: 100 });
    await expect(sweep.commit(() => true, scheduler)).resolves.toBe(true);
  });

  it("rechecks conservative-bound misses on later segments and commits every exact hit", async () => {
    const exactMiss = { ...rectangle, id: "miss", x: 40, y: 40 };
    const laterHit = { ...rectangle, id: "hit", x: 140, y: 40, pivot: { x: 150, y: 50 } };
    const elements = new Map([
      [exactMiss.id, exactMiss],
      [laterHit.id, laterHit],
    ]);
    const sweep = new EraserSweep(
      { x: 0, y: 35 },
      2,
      {
        getElement: (id) => elements.get(id),
        query: (_bounds, sink) => addIds(sink, [exactMiss.id, laterHit.id]),
      },
      { clearCandidateFade: () => undefined, setCandidateFade: () => undefined },
    );

    sweep.update({ x: 100, y: 35 });
    sweep.update({ x: 200, y: 50 });
    const removed: string[] = [];
    await sweep.commit((ids) => {
      removed.push(...ids);
      return true;
    }, scheduler);

    expect(removed).toEqual(["hit"]);
  });
});

describe("eraser resource limits", () => {
  it("bounds retained work and cancels instead of committing a truncated sweep", async () => {
    const stroke = createLongStroke("blocking-stroke", 60_000);
    const sweep = createSingleStrokeSweep(stroke);
    let result = "accepted";
    for (let index = 0; index < MAX_RETAINED_ERASER_SWEEPS * 2; index += 1) {
      result = sweep.update({ x: index % 2, y: 0 });
      expect(sweep.retainedSweepCount).toBeLessThanOrEqual(MAX_RETAINED_ERASER_SWEEPS);
      expect(sweep.retainedCandidateIdCount).toBeLessThanOrEqual(1);
      if (result === "cancelled") break;
    }
    const remove = vi.fn(() => true);

    expect(result).toBe("cancelled");
    await expect(sweep.commit(remove, scheduler)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("cancels time-sliced finalization without a partial removal", async () => {
    const stroke = createLongStroke("cancelled-stroke", 20_000);
    const sweep = createSingleStrokeSweep(stroke);
    const remove = vi.fn(() => true);

    await expect(
      sweep.commit(remove, {
        isCancelled: () => true,
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    ).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});

function createLongStroke(id: string, pointCount: number): StrokeElementV1 {
  const points: number[] = [];
  for (let index = 0; index < pointCount; index += 1) points.push(index, 100, 0.5);
  const base = indexedStroke(2);
  return {
    ...base,
    id,
    pivot: { x: pointCount / 2, y: 50 },
    points,
  };
}

function createSingleStrokeSweep(stroke: StrokeElementV1): EraserSweep {
  return new EraserSweep(
    { x: 0, y: 0 },
    1,
    {
      getElement: () => stroke,
      query: (_bounds, sink) => sink.add(stroke.id),
    },
    { clearCandidateFade: () => undefined, setCandidateFade: () => undefined },
  );
}
