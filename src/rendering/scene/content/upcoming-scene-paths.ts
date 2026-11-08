import type { PendingReconciliation } from "../reconciliation/reconciliation-state";

/** Shares lookahead between missing entrants and mounted catch-up without materializing IDs. */
export function* upcomingScenePathIds(
  pending: PendingReconciliation | undefined,
  mounted: { has(id: string): boolean },
  geometry?: Iterable<string>,
): Iterable<string> {
  const dirty = geometry?.[Symbol.iterator]();
  for (const id of upcomingVisibilityIds(pending, mounted)) {
    yield id;
    const next = dirty?.next();
    if (next !== undefined && !next.done) yield next.value;
  }
  if (dirty !== undefined) {
    for (let next = dirty.next(); !next.done; next = dirty.next()) yield next.value;
  }
}

function* upcomingVisibilityIds(
  pending: PendingReconciliation | undefined,
  mounted: { has(id: string): boolean },
): Iterable<string> {
  if (pending === undefined) return;
  if (pending.delta !== undefined) {
    yield* upcomingDeltaIds(pending, mounted);
    return;
  }
  const bands =
    pending.cursor.band === "highlight"
      ? (["highlight", "content"] as const)
      : (["content"] as const);
  for (const band of bands) {
    const visible = pending.visibility[band];
    const end = band === pending.cursor.band ? pending.cursor.index : visible.count - 1;
    for (let index = end; index >= 0; index -= 1) {
      const id = visible.ids[index];
      if (id !== undefined && !mounted.has(id) && !pending.entrants.has(id)) yield id;
    }
  }
}

function* upcomingDeltaIds(
  pending: PendingReconciliation,
  mounted: { has(id: string): boolean },
): Iterable<string> {
  const delta = pending.delta!;
  for (let index = delta.index; index < delta.ids.length; index += 1) {
    const id = delta.ids[index]!;
    if (!mounted.has(id) && !pending.entrants.has(id)) yield id;
  }
  // Deferred candidates stay in priority order after an asynchronous response.
  for (const id of delta.deferred) {
    if (!mounted.has(id) && !pending.entrants.has(id)) yield id;
  }
  const priority = delta.priority;
  if (priority === undefined) return;
  while (true) {
    const generation = priority.heapGeneration;
    for (const id of priority.upcoming(Infinity)) {
      if (!mounted.has(id) && !pending.entrants.has(id)) yield id;
    }
    if (generation === priority.heapGeneration) return;
  }
}
