import type { RenderBand } from "../commands/render-bands";

import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { ElementMutation, ElementRank } from "./types";

export async function validateTrustedRemovalOrder(
  requested: ElementMutation,
  source: Readonly<{ bands: Readonly<Record<RenderBand, readonly string[]>> }>,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
): Promise<
  | {
      bands: Record<RenderBand, string[]>;
      ranks: Map<string, ElementRank>;
      dirtyBands: Record<RenderBand, boolean>;
      relativeOrderPreserved: Record<RenderBand, boolean>;
    }
  | "cancelled"
> {
  const bands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  const ranks = new Map<string, ElementRank>();
  const dirtyBands = { content: false, highlight: false };
  for (const band of ["highlight", "content"] as const) {
    let firstChanged = source.bands[band].length;
    for (const id of removeIds) {
      if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
      const rank = sourceRanks.get(id);
      if (rank?.band === band) firstChanged = Math.min(firstChanged, rank.rank);
    }
    const next = requested.bands[band];
    dirtyBands[band] = firstChanged < source.bands[band].length;
    for (let index = 0; index < next.length; index += 1) {
      if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
      const id = next[index]!;
      bands[band].push(id);
      if (index >= firstChanged) ranks.set(id, { band, rank: index });
    }
  }
  return { bands, ranks, dirtyBands, relativeOrderPreserved: { content: true, highlight: true } };
}
