import { renderBandOf } from "../commands/render-bands";
import type { InkElementV1 } from "../schema/public";
import type { CompactMutationSource } from "./compact-mutation-types";
import type { ElementMutation, ElementPlacement } from "./types";

export function validateCompactPlacements(
  source: CompactMutationSource,
  requested: ElementMutation,
): readonly ElementPlacement[] {
  const placements = (requested.placements ?? []).map((placement) => Object.freeze({ ...placement }));
  placements.sort((left, right) => left.rank - right.rank);
  const created = new Map((requested.elements ?? []).filter((element) => !source.records.has(element.id)).map((element) => [element.id, element]));
  const sizes = { content: source.sizeOfBand("content"), highlight: source.sizeOfBand("highlight") };
  for (const id of new Set(requested.removeIds ?? [])) {
    const rank = source.getRank(id);
    if (rank !== undefined) sizes[rank.band] -= 1;
  }
  const seen = new Set<string>();
  const previous = { content: -1, highlight: -1 };
  for (const placement of placements) {
    const element = created.get(placement.id);
    if (element === undefined || seen.has(placement.id) || renderBandOf(element) !== placement.band || !Number.isSafeInteger(placement.rank) || placement.rank < 0 || placement.rank > sizes[placement.band] || previous[placement.band] === placement.rank) {
      throw new RangeError("Mutation placements must identify each new element at a unique valid band rank.");
    }
    seen.add(placement.id);
    previous[placement.band] = placement.rank;
    sizes[placement.band] += 1;
  }
  if (seen.size !== created.size) throw new RangeError("Every new element requires a mutation placement.");
  return Object.freeze(placements);
}

export function expandCompactMutation(
  source: CompactMutationSource,
  requested: ElementMutation,
): ElementMutation {
  const placements = validateCompactPlacements(source, requested);
  const removed = new Set(requested.removeIds ?? []);
  const bands = { content: source.bands.content.filter((id) => !removed.has(id)), highlight: source.bands.highlight.filter((id) => !removed.has(id)) };
  for (const placement of placements) bands[placement.band].splice(placement.rank, 0, placement.id);
  return { bands, elements: requested.elements ?? [], removeIds: requested.removeIds ?? [] };
}

export function freezeCompactMutation(input: {
  readonly elements: readonly InkElementV1[];
  readonly placements: readonly ElementPlacement[];
  readonly removeIds: readonly string[];
}): ElementMutation {
  return Object.freeze({ elements: Object.freeze(input.elements), placements: Object.freeze(input.placements), removeIds: Object.freeze(input.removeIds) });
}
