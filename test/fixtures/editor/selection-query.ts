import { calculateElementBounds, type Bounds } from "../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import {
  elementMatchesSelectionAreaSteps,
  type SelectionArea,
  type SelectionAreaInclusion,
} from "../../../src/editor/selection/selection-area";
import {
  primitiveTouchesAreaSteps,
  type AreaPolygon,
  type VisibleSelectionPrimitive,
} from "../../../src/editor/selection/selection-area-primitives";
import {
  selectBySelectionAreaCandidatesSteps,
  type SelectionAreaCandidate,
} from "../../../src/editor/selection/selection-model";

/** Complete the production cooperative query synchronously for focused assertions. */
export function elementMatchesSelectionArea(
  area: SelectionArea,
  element: InkElementV1,
  inclusion: SelectionAreaInclusion,
  bounds: Bounds = calculateElementBounds(element),
): boolean {
  return complete(elementMatchesSelectionAreaSteps(area, element, inclusion, bounds));
}

export function primitiveTouchesArea(
  area: AreaPolygon,
  primitive: VisibleSelectionPrimitive,
): boolean {
  return complete(primitiveTouchesAreaSteps(area, primitive));
}

export function selectBySelectionAreaQuery(
  selection: ReadonlySet<string>,
  area: SelectionArea,
  inclusion: SelectionAreaInclusion,
  additive: boolean,
  query: (
    bounds: Bounds,
    sink: { add(id: string, bounds: Bounds, element: InkElementV1): void },
  ) => void,
): ReadonlySet<string> {
  const candidates: SelectionAreaCandidate[] = [];
  query(area.bounds, {
    add: (id, bounds, element) => {
      candidates.push({ id, bounds, element });
    },
  });
  return complete(
    selectBySelectionAreaCandidatesSteps(
      selection,
      area,
      inclusion,
      additive,
      candidateSteps(candidates),
    ),
  );
}

function* candidateSteps(
  candidates: readonly SelectionAreaCandidate[],
): Generator<SelectionAreaCandidate, boolean> {
  yield* candidates;
  return true;
}

function complete<T>(steps: Generator<void, T>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}
