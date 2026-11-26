import { describe, expect, it, vi } from "vitest";

import type { BoxShapeElementV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { EraserSweep } from "../../../../src/editor/gestures/eraser-gesture";
import { eraserQuery } from "../../../fixtures/editor/eraser-query";
import { indexedStroke } from "../../../fixtures/editor/stroke";

const scheduler = {
  isCancelled: () => false,
  shouldYield: () => false,
  yieldControl: async () => undefined,
};

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
    outlineColor: { type: "rgba", value: "#000000FF" },
    outlineWidth: 2,
    outlineOpacity: 1,
    outlineStyle: "solid",
    fillColor: null,
    fillOpacity: 0,
  },
};

it("leaves locked elements intact and does not prepare their text geometry or fade", async () => {
  const fade = { setCandidateFade: vi.fn(), clearCandidateFade: vi.fn() };
  const getTextGeometry = vi.fn();
  const sweep = new EraserSweep(
    { x: 0, y: 50 },
    4,
    {
      beginQuery: () => eraserQuery([rectangle.id]),
      getElement: () => ({ ...rectangle, locked: true }),
      getTextGeometry,
    },
    fade,
  );
  sweep.update({ x: 100, y: 50 });
  const remove = vi.fn(() => true);
  await expect(sweep.commit(remove, scheduler)).resolves.toBe(false);
  expect(remove).not.toHaveBeenCalled();
  expect(getTextGeometry).not.toHaveBeenCalled();
  expect(fade.setCandidateFade).not.toHaveBeenCalled();
});

describe("eraser sweep", () => {
  it("keeps candidates in the model until one atomic removal commit", async () => {
    const setFade = vi.fn();
    const clearFade = vi.fn();
    const sweep = new EraserSweep(
      { x: 0, y: 50 },
      4,
      { beginQuery: () => eraserQuery(["shape"]), getElement: () => rectangle },
      { setCandidateFade: setFade, clearCandidateFade: clearFade },
    );
    sweep.update({ x: 100, y: 50 });
    expect(setFade).toHaveBeenLastCalledWith(new Set(["shape"]));
    const remove = vi.fn(() => true);
    await expect(sweep.commit(remove, scheduler)).resolves.toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(clearFade).toHaveBeenCalledOnce();
  });
});

describe("eraser resource limits", () => {
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
      beginQuery: () => eraserQuery([stroke.id]),
    },
    { clearCandidateFade: () => undefined, setCandidateFade: () => undefined },
    undefined,
    () => true,
  );
}
