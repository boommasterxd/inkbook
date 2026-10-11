import { arrangeRenderBandSteps, type ArrangeAction } from "../commands/arrange";
import type { RenderBand } from "../commands/render-bands";
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { createUnchangedMutationOrder, type MutationOrder } from "./mutation-order";
import type { ElementMutation, ElementRank, StoreSliceScheduler } from "./types";

interface ArrangementSource {
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly ranks: ReadonlyMap<string, ElementRank>;
}

export function arrangementRange(
  length: number,
  selected: Readonly<{ first: number; last: number }>,
  action: ArrangeAction,
): readonly [number, number] {
  switch (action) {
    case "bring-forward":
      return [selected.first, Math.min(length, selected.last + 2)];
    case "send-backward":
      return [Math.max(0, selected.first - 1), selected.last + 1];
    case "bring-to-front":
      return [selected.first, length];
    case "send-to-back":
      return [0, selected.last + 1];
  }
}

/** Private producer: untouched authoritative bands never leave the owning Store. */
export async function prepareArrangementMutation(
  source: ArrangementSource,
  action: ArrangeAction,
  selection: ReadonlySet<string>,
  scheduler: StoreSliceScheduler,
): Promise<
  { readonly mutation: ElementMutation; readonly order: MutationOrder } | "cancelled" | null
> {
  const work = new MutationPreparationScheduler(scheduler);
  const pendingRanges = work.run(selectedArrangementRanges(source, selection));
  const ranges = pendingRanges instanceof Promise ? await pendingRanges : pendingRanges;
  if (ranges === "cancelled") return ranges;
  const order = createUnchangedMutationOrder(source.bands);
  const { bands, ranks, dirtyBands, relativeOrderPreserved } = order;
  for (const [band, selected] of ranges) {
    const [start, end] = arrangementRange(source.bands[band].length, selected, action);
    const prepared = await prepareArrangedBand(
      source,
      { band, start, end, action, ranks },
      selection,
      work,
    );
    if (prepared === "cancelled") return prepared;
    if (prepared === null) continue;
    bands[band] = prepared;
    dirtyBands[band] = true;
    relativeOrderPreserved[band] = false;
  }
  if (scheduler.isCancelled?.()) return "cancelled";
  if (!dirtyBands.content && !dirtyBands.highlight) return null;
  return { mutation: { bands }, order };
}

function* selectedArrangementRanges(source: ArrangementSource, selection: ReadonlySet<string>) {
  const ranges = new Map<RenderBand, { first: number; last: number }>();
  for (const id of selection) {
    yield;
    const rank = source.ranks.get(id);
    if (rank === undefined) continue;
    const range = ranges.get(rank.band);
    if (range === undefined) ranges.set(rank.band, { first: rank.rank, last: rank.rank });
    else {
      range.first = Math.min(range.first, rank.rank);
      range.last = Math.max(range.last, rank.rank);
    }
  }
  return ranges;
}

async function prepareArrangedBand(
  source: ArrangementSource,
  range: Readonly<{
    band: RenderBand;
    start: number;
    end: number;
    action: ArrangeAction;
    ranks: Map<string, ElementRank>;
  }>,
  selection: ReadonlySet<string>,
  work: MutationPreparationScheduler,
) {
  const { band, start, end, action, ranks } = range;
  const affected: string[] = [];
  for (let index = start; index < end; index += 1) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    affected.push(source.bands[band][index]!);
  }
  const pending = work.run(arrangeRenderBandSteps(affected, (id) => selection.has(id), action));
  const arranged = pending instanceof Promise ? await pending : pending;
  if (arranged === "cancelled") return arranged;
  if (!arranged.changed) return null;
  const next: string[] = [];
  for (let index = 0; index < source.bands[band].length; index += 1) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    const id =
      index >= start && index < end
        ? arranged.elements[index - start]!
        : source.bands[band][index]!;
    next.push(id);
    if (index >= start && index < end && affected[index - start] !== id)
      ranks.set(id, { band, rank: index });
  }
  return next;
}
