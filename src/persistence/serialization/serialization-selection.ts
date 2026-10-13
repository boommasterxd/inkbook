import type { InkElementV1 } from "../../domain/schema/public";
import { renderBandOf, type RenderBand } from "../../domain/commands/render-bands";

export interface SerializationRank {
  readonly band: RenderBand;
  readonly rank: number;
}

export type SerializationRanks = Record<RenderBand, Map<string, SerializationRank>>;

export function* prepareSerializationRanks(
  orders: Readonly<Record<RenderBand, readonly string[]>>,
  nodesPerStep: number,
): Generator<void, SerializationRanks> {
  const ranks: SerializationRanks = { content: new Map(), highlight: new Map() };
  let visited = 0;
  for (const band of ["highlight", "content"] as const) {
    for (let rank = 0; rank < orders[band].length; rank += 1) {
      ranks[band].set(orders[band][rank]!, { band, rank });
      if (++visited % nodesPerStep === 0) yield;
    }
  }
  return ranks;
}

interface RankPatchSource {
  readonly currentOrders: Readonly<Record<RenderBand, readonly string[]>>;
  readonly nextOrders: Readonly<Record<RenderBand, readonly string[]>>;
  readonly currentRanks: SerializationRanks;
}

/** Stages only changed bands; the owning model applies this after its final epoch check. */
export function* prepareSerializationRankUpdate(
  { currentOrders, nextOrders, currentRanks }: RankPatchSource,
  nodesPerStep: number,
): Generator<void, SerializationRanks> {
  const next = { ...currentRanks };
  let visited = 0;
  for (const band of ["highlight", "content"] as const) {
    if (currentOrders[band] === nextOrders[band]) continue;
    const prepared = new Map<string, SerializationRank>();
    for (let rank = 0; rank < nextOrders[band].length; rank += 1) {
      const id = nextOrders[band][rank]!;
      const current = currentRanks[band].get(id);
      prepared.set(id, current?.rank === rank ? current : { band, rank });
      if (++visited % nodesPerStep === 0) yield;
    }
    next[band] = prepared;
  }
  return next.content === currentRanks.content && next.highlight === currentRanks.highlight
    ? currentRanks
    : next;
}

/** Only selected IDs are read; validated ranks preserve the fixed render-band order. */
export function* serializationSelectionSteps(
  elements: ReadonlyMap<string, InkElementV1>,
  ranks: Readonly<Record<RenderBand, ReadonlyMap<string, SerializationRank>>>,
  selectedIds: readonly string[],
): Generator<void, InkElementV1[] | null> {
  const selected: Array<{ element: InkElementV1; position: SerializationRank }> = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const element = elements.get(id);
    if (element === undefined) return null;
    const position = ranks[renderBandOf(element)].get(id);
    if (position === undefined) return null;
    selected.push({ element, position });
    yield;
  }
  selected.sort((left, right) =>
    left.position.band === right.position.band
      ? left.position.rank - right.position.rank
      : left.position.band === "highlight"
        ? -1
        : 1,
  );
  return selected.map(({ element }) => element);
}
