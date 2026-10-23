import type { RenderBand } from "../../commands/render-bands";

import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { StoreBands } from "./band-snapshots";
import type { ElementMutation, ElementRank } from "../types";

export async function validateTrustedRemovalOrder(
  requested: ElementMutation,
  source: Readonly<{ bands: Readonly<Record<RenderBand, readonly string[]>> }>,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
): Promise<
  | {
      bands: StoreBands;
      ranks: Map<string, ElementRank>;
      dirtyBands: Record<RenderBand, boolean>;
      relativeOrderPreserved: Record<RenderBand, boolean>;
    }
  | "cancelled"
> {
  const bands: StoreBands = {
    content: source.bands.content,
    highlight: source.bands.highlight,
  };
  const ranks = new Map<string, ElementRank>();
  const dirtyBands = { content: false, highlight: false };
  const firstChanged = {
    content: source.bands.content.length,
    highlight: source.bands.highlight.length,
  };
  for (const id of removeIds) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const rank = sourceRanks.get(id);
    if (rank !== undefined) firstChanged[rank.band] = Math.min(firstChanged[rank.band], rank.rank);
  }
  for (const band of ["highlight", "content"] as const) {
    const next = requested.bands[band];
    dirtyBands[band] = firstChanged[band] < source.bands[band].length;
    if (!dirtyBands[band]) continue;
    const ids: string[] = [];
    bands[band] = ids;
    for (let index = 0; index < next.length; index += 1) {
      if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
      const id = next[index]!;
      ids.push(id);
      if (index >= firstChanged[band]) ranks.set(id, { band, rank: index });
    }
  }
  return { bands, ranks, dirtyBands, relativeOrderPreserved: { content: true, highlight: true } };
}
