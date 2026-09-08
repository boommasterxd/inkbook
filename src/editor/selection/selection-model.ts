import type { Bounds } from "../../domain/geometry/public";
import type { InkElementV1 } from "../../domain/schema/public";

import {
  elementMatchesSelectionArea,
  selectionAreaBounds,
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

interface SelectionAreaCandidateSink {
  add(id: string, bounds: Bounds, element: InkElementV1): void;
}

export function selectBySelectionAreaQuery(
  selection: ReadonlySet<string>,
  area: SelectionArea,
  inclusion: SelectionAreaInclusion,
  additive: boolean,
  query: (bounds: Bounds, sink: SelectionAreaCandidateSink) => void,
): ReadonlySet<string> {
  const next = additive ? new Set(selection) : new Set<string>();
  query(selectionAreaBounds(area), {
    add: (id, bounds, element) => {
      if (elementMatchesSelectionArea(area, element, inclusion, bounds)) next.add(id);
    },
  });
  return setsEqual(selection, next) ? selection : next;
}

function singleton(id: string): ReadonlySet<string> {
  return new Set([id]);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}
