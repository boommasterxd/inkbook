import { boundsIntersect } from "../../domain/geometry/bounds";
import type { Bounds } from "../../domain/geometry/public";

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

export function selectByLasso(
  selection: ReadonlySet<string>,
  lasso: Bounds,
  candidates: Iterable<readonly [string, Bounds]>,
  additive: boolean,
): ReadonlySet<string> {
  const next = additive ? new Set(selection) : new Set<string>();
  for (const [id, bounds] of candidates) {
    if (boundsIntersect(lasso, bounds)) next.add(id);
  }
  return setsEqual(selection, next) ? selection : next;
}

export interface LassoCandidateSink {
  add(id: string, bounds: Bounds): void;
}

export function selectByLassoQuery(
  selection: ReadonlySet<string>,
  lasso: Bounds,
  additive: boolean,
  query: (sink: LassoCandidateSink) => void,
): ReadonlySet<string> {
  const next = additive ? new Set(selection) : new Set<string>();
  query({
    add: (id, bounds) => {
      if (boundsIntersect(lasso, bounds)) next.add(id);
    },
  });
  return setsEqual(selection, next) ? selection : next;
}

export function lassoBounds(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): Bounds {
  return {
    minX: Math.min(start.x, end.x),
    minY: Math.min(start.y, end.y),
    maxX: Math.max(start.x, end.x),
    maxY: Math.max(start.y, end.y),
  };
}

function singleton(id: string): ReadonlySet<string> {
  return new Set([id]);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}
