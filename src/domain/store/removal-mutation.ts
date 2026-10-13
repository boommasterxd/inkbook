import type { RenderBand } from "../commands/render-bands";

import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { createUnchangedMutationOrder, type MutationOrder } from "./mutation-order";
import type { ElementMutation, ElementRank, ElementRecord, StoreSliceScheduler } from "./types";

interface RemovalSource {
  readonly records: ReadonlyMap<string, ElementRecord>;
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly ranks: ReadonlyMap<string, ElementRank>;
}

/** Private orders borrow untouched bands; public mutation arrays remain isolated and frozen. */
export async function prepareRemovalMutation(
  ids: ReadonlySet<string> | readonly string[],
  source: RemovalSource,
  scheduler: StoreSliceScheduler,
): Promise<
  { readonly mutation: ElementMutation; readonly order: MutationOrder } | "cancelled" | null
> {
  const work = new MutationPreparationScheduler(scheduler);
  const removed: string[] = [];
  const removeIds = new Set<string>();
  const firstChanged = {
    content: source.bands.content.length,
    highlight: source.bands.highlight.length,
  };
  for (const id of ids) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    if (!source.records.has(id) || removeIds.has(id)) continue;
    removed.push(id);
    removeIds.add(id);
    const position = source.ranks.get(id)!;
    firstChanged[position.band] = Math.min(firstChanged[position.band], position.rank);
  }
  if (removed.length === 0) return null;
  const order = createUnchangedMutationOrder(source.bands);
  const publicBands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  for (const band of ["highlight", "content"] as const) {
    const next = await prepareRemovalBand(
      band,
      source.bands[band],
      { firstChanged: firstChanged[band], removeIds, order },
      work,
    );
    if (next === "cancelled") return next;
    publicBands[band] = next;
  }
  if (scheduler.isCancelled?.()) return "cancelled";
  const mutation = Object.freeze({
    bands: Object.freeze({
      content: Object.freeze(publicBands.content),
      highlight: Object.freeze(publicBands.highlight),
    }),
    removeIds: Object.freeze(removed),
  });
  return { mutation, order };
}

async function prepareRemovalBand(
  band: RenderBand,
  current: readonly string[],
  state: Readonly<{
    firstChanged: number;
    removeIds: ReadonlySet<string>;
    order: MutationOrder;
  }>,
  work: MutationPreparationScheduler,
): Promise<string[] | "cancelled"> {
  const changed = state.firstChanged < current.length;
  const publicIds: string[] = [];
  const next: string[] = [];
  for (const id of current) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    if (changed && state.removeIds.has(id)) continue;
    publicIds.push(id);
    if (!changed) continue;
    const rank = next.length;
    next.push(id);
    if (rank >= state.firstChanged) state.order.ranks.set(id, { band, rank });
  }
  if (changed) {
    state.order.bands[band] = next;
    state.order.dirtyBands[band] = true;
  }
  return publicIds;
}
