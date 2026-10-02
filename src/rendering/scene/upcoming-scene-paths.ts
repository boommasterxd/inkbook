import type { PendingReconciliation } from "./reconciliation-state";

/** Matches both full-band and delta entrant mount order without materializing visible IDs. */
export function* upcomingScenePathIds(
  pending: PendingReconciliation | undefined,
  mounted: { has(id: string): boolean },
): Iterable<string> {
  if (pending === undefined) return;
  if (pending.delta !== undefined) {
    for (let index = pending.delta.index; index < pending.delta.ids.length; index += 1) {
      const id = pending.delta.ids[index]!;
      if (!mounted.has(id) && !pending.entrants.has(id)) yield id;
    }
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
