import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import type { Bounds } from "../../domain/geometry/public";
import type { InkElementV1 } from "../../domain/schema/public";

import {
  elementMatchesSelectionAreaSteps,
  type SelectionArea,
  type SelectionAreaInclusion,
} from "./selection-area";

export type SelectionMode = "add" | "preserve-or-replace" | "replace";

export function selectElement(
  selection: ReadonlySet<string>,
  elementId: string,
  mode: SelectionMode,
): ReadonlySet<string> {
  if (mode === "preserve-or-replace" && selection.has(elementId)) return selection;
  if (mode === "replace") return singleton(elementId);
  const next = new Set(selection);
  next.add(elementId);
  return setsEqual(selection, next) ? selection : next;
}

export interface SelectionAreaCandidate {
  readonly id: string;
  readonly bounds: Bounds;
  readonly element: InkElementV1;
  readonly preparedPressure?: PreparedPressureGeometryPort;
}

/** A false candidate-stream result discards an invalidated spatial query atomically. */
export function* selectBySelectionAreaCandidatesSteps(
  selection: ReadonlySet<string>,
  area: SelectionArea,
  inclusion: SelectionAreaInclusion,
  additive: boolean,
  candidates: Generator<SelectionAreaCandidate | undefined, boolean>,
): Generator<void, ReadonlySet<string>> {
  const next = additive ? new Set(selection) : new Set<string>();
  try {
    let step = candidates.next();
    while (!step.done) {
      if (step.value !== undefined) {
        const { id, bounds, element, preparedPressure } = step.value;
        if (
          yield* elementMatchesSelectionAreaSteps(
            area,
            element,
            inclusion,
            bounds,
            preparedPressure,
          )
        )
          next.add(id);
      }
      yield;
      step = candidates.next();
    }
    return !step.value || setsEqual(selection, next) ? selection : next;
  } finally {
    candidates.return(false);
  }
}

function singleton(id: string): ReadonlySet<string> {
  return new Set([id]);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}
