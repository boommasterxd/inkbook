import type { RenderBand } from "../commands/render-bands";

import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { ElementMutation, ElementRecord, StoreSliceScheduler } from "./types";

export async function createRemovalMutationTimeSliced(
  ids: ReadonlySet<string> | readonly string[],
  records: ReadonlyMap<string, ElementRecord>,
  currentBands: Readonly<Record<RenderBand, readonly string[]>>,
  scheduler: StoreSliceScheduler,
): Promise<ElementMutation | "cancelled" | null> {
  const work = new MutationPreparationScheduler(scheduler);
  const removed: string[] = [];
  const removeIds = new Set<string>();
  for (const id of ids) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    if (!records.has(id) || removeIds.has(id)) continue;
    removed.push(id);
    removeIds.add(id);
  }
  if (removed.length === 0) return null;
  const bands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  for (const band of ["highlight", "content"] as const) {
    for (const id of currentBands[band]) {
      if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
      if (!removeIds.has(id)) bands[band].push(id);
    }
  }
  if (scheduler.isCancelled?.()) return "cancelled";
  return Object.freeze({
    bands: Object.freeze({
      content: Object.freeze(bands.content),
      highlight: Object.freeze(bands.highlight),
    }),
    removeIds: Object.freeze(removed),
  });
}
