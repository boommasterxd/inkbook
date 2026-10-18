import type { RenderBand } from "../commands/render-bands";
import { retainBandSnapshot } from "./band-snapshots";

import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { createUnchangedMutationOrder, type MutationOrder } from "./mutation-order";
import type { ElementMutation, ElementRank, ElementRecord, StoreSliceScheduler } from "./types";

interface RemovalSource {
  readonly records: ReadonlyMap<string, ElementRecord>;
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly ranks: ReadonlyMap<string, ElementRank>;
}

/** Store-owned frozen snapshots can serve both public order and private preparation. */
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
  const removedByBand = { content: 0, highlight: 0 };
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
    removedByBand[position.band] += 1;
    firstChanged[position.band] = Math.min(firstChanged[position.band], position.rank);
  }
  if (removed.length === 0) return null;
  const order = createUnchangedMutationOrder(source.bands);
  const changedRanks =
    source.bands.content.length -
    removedByBand.content -
    firstChanged.content +
    source.bands.highlight.length -
    removedByBand.highlight -
    firstChanged.highlight;
  // A complete map replaces two writes per changed survivor with one per survivor.
  order.ranksComplete = 2 * changedRanks > source.records.size - removed.length;
  for (const band of ["highlight", "content"] as const) {
    const next = await prepareRemovalBand(
      band,
      source.bands[band],
      { firstChanged: firstChanged[band], removeIds, order, sourceRanks: source.ranks },
      work,
    );
    if (next === "cancelled") return next;
  }
  if (scheduler.isCancelled?.()) return "cancelled";
  const mutation = Object.freeze({
    bands: Object.freeze({
      content: retainBandSnapshot(order.bands.content),
      highlight: retainBandSnapshot(order.bands.highlight),
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
    sourceRanks: ReadonlyMap<string, ElementRank>;
  }>,
  work: MutationPreparationScheduler,
): Promise<void | "cancelled"> {
  const changed = state.firstChanged < current.length;
  if (!changed && !state.order.ranksComplete) return;
  const next: string[] = [];
  for (const id of current) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    if (changed && state.removeIds.has(id)) continue;
    const rank = next.length;
    if (changed) next.push(id);
    if (changed && rank >= state.firstChanged) state.order.ranks.set(id, { band, rank });
    else if (state.order.ranksComplete) state.order.ranks.set(id, state.sourceRanks.get(id)!);
  }
  if (changed) {
    state.order.bands[band] = next;
    state.order.dirtyBands[band] = true;
  }
}
