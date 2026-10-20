import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import type { SelectionScaleGesture } from "../../../src/editor/selection/selection-scale";
import { maximumStroke } from "./maximum-stroke-fixture";

export const PASS_THROUGH_PLANNER = {
  countReverseDependencies: () => 0,
  planReplacements: (replacements: readonly InkElementV1[]) => ({
    elements: replacements,
    replacements,
  }),
  planReplacementsTimeSliced: async (replacements: readonly InkElementV1[]) => ({
    elements: replacements,
    replacements,
  }),
};

export function createRotatedScaleFixture(
  typed: boolean,
  scaleClass: typeof SelectionScaleGesture,
) {
  const source = maximumStroke(0);
  const element = {
    ...source,
    rotation: 37,
    points: (typed ? new Float64Array(source.points) : source.points) as StrokeElementV1["points"],
  };
  const pointer = { x: 4100, y: 200 };
  const gesture = new scaleClass(
    { anchor: { x: 0, y: 0 }, kind: "scale", position: "bottom-right", rotation: 0 },
    [element, maximumStroke(1)],
    pointer,
  );
  return { source, element, pointer, gesture, factors: { x: 1.25, y: 0.75 } };
}
