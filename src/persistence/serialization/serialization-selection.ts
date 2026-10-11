import type { InkElementV1 } from "../../domain/schema/public";
import type { RenderBand } from "../../domain/commands/render-bands";

export interface SerializationRank {
  readonly band: RenderBand;
  readonly rank: number;
}

export function* prepareSerializationRanks(
  orders: Readonly<Record<RenderBand, readonly string[]>>,
  nodesPerStep: number,
): Generator<void, Map<string, SerializationRank>> {
  const ranks = new Map<string, SerializationRank>();
  for (const band of ["highlight", "content"] as const) {
    for (let rank = 0; rank < orders[band].length; rank += 1) {
      ranks.set(orders[band][rank]!, { band, rank });
      if (ranks.size % nodesPerStep === 0) yield;
    }
  }
  return ranks;
}

/** Only selected IDs are read; validated ranks preserve the fixed render-band order. */
export function* serializationSelectionSteps(
  elements: ReadonlyMap<string, InkElementV1>,
  ranks: ReadonlyMap<string, SerializationRank>,
  selectedIds: readonly string[],
): Generator<void, InkElementV1[] | null> {
  const selected: Array<{ element: InkElementV1; position: SerializationRank }> = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const element = elements.get(id);
    const position = ranks.get(id);
    if (element === undefined || position === undefined) return null;
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
