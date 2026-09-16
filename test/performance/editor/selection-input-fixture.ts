import type {
  InkElementV1,
  LineElementV1,
  StrokeElementV1,
} from "../../../src/domain/schema/public";
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

export function createHandleLine(): LineElementV1 {
  return {
    bend: null,
    createdAt: 1,
    end: { x: 400, y: 100 },
    endConnection: null,
    endNode: "none",
    id: "20000000-0000-4000-8000-000000000011",
    kind: "line",
    pivot: { x: 250, y: 100 },
    rotation: 0,
    start: { x: 100, y: 100 },
    startConnection: null,
    startNode: "none",
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  };
}

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
