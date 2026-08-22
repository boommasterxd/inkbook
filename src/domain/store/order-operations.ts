import type { ArrangeAction } from "../commands/arrange";
import { renderBandOf, type RenderBand } from "../commands/render-bands";

import type { DeltaBuilder } from "./delta-builder";
import type { ElementRank, ElementRecord, ImmutableInkElement } from "./types";

interface OrderingState {
  readonly bands: Record<RenderBand, string[]>;
  readonly ranks: Map<string, ElementRank>;
  readonly records: ReadonlyMap<string, ElementRecord>;
}

export class ElementStoreOrdering {
  readonly #state: () => OrderingState;

  public constructor(state: () => OrderingState) {
    this.#state = state;
  }

  public insert(
    element: ImmutableInkElement,
    placement: "back" | "front",
    delta: DeltaBuilder,
  ): void {
    const state = this.#state();
    const band = renderBandOf(element);
    const ids = state.bands[band];
    if (placement === "front") {
      state.ranks.set(element.id, { band, rank: ids.length });
      ids.push(element.id);
    } else {
      ids.unshift(element.id);
      state.ranks.set(element.id, { band, rank: 0 });
      this.refresh(band, 1, delta);
    }
    delta.dirtyBand(band);
  }

  public refresh(band: RenderBand, start: number, delta: DeltaBuilder): void {
    const state = this.#state();
    const ids = state.bands[band];
    for (let rank = start; rank < ids.length; rank += 1) {
      const id = ids[rank]!;
      const previous = state.ranks.get(id);
      if (previous?.rank === rank && previous.band === band) continue;
      state.ranks.set(id, { band, rank });
      const record = state.records.get(id);
      if (record === undefined) throw new RangeError(`Unknown element ID: ${id}`);
      delta.add(id, record, record, ["order"]);
      delta.dirtyBand(band);
    }
  }
}

export function assertCompleteBandOrder(
  current: readonly string[],
  band: RenderBand,
  orderedIds: readonly string[],
  bandOf: (id: string) => RenderBand | undefined,
): void {
  if (orderedIds.length !== current.length) throw new RangeError("Band order must be complete.");
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id) || bandOf(id) !== band) {
      throw new RangeError("Band order contains a duplicate, missing, or cross-band ID.");
    }
    seen.add(id);
  }
}

export function arrangeIdsInPlace(
  ids: string[],
  selectedIds: ReadonlySet<string>,
  action: ArrangeAction,
): boolean {
  if (ids.length < 2 || selectedIds.size === 0) return false;
  switch (action) {
    case "bring-forward":
      return bringForward(ids, selectedIds);
    case "send-backward":
      return sendBackward(ids, selectedIds);
    case "bring-to-front":
      return stablePartition(ids, selectedIds, true);
    case "send-to-back":
      return stablePartition(ids, selectedIds, false);
  }
}

function bringForward(ids: string[], selectedIds: ReadonlySet<string>): boolean {
  let changed = false;
  let index = 0;
  while (index < ids.length) {
    if (!selectedIds.has(ids[index]!)) {
      index += 1;
      continue;
    }
    const runStart = index;
    while (index < ids.length && selectedIds.has(ids[index]!)) index += 1;
    if (index >= ids.length) break;
    const next = ids[index]!;
    for (let move = index; move > runStart; move -= 1) ids[move] = ids[move - 1]!;
    ids[runStart] = next;
    changed = true;
    index += 1;
  }
  return changed;
}

function sendBackward(ids: string[], selectedIds: ReadonlySet<string>): boolean {
  let changed = false;
  let index = ids.length - 1;
  while (index >= 0) {
    if (!selectedIds.has(ids[index]!)) {
      index -= 1;
      continue;
    }
    const runEnd = index;
    while (index >= 0 && selectedIds.has(ids[index]!)) index -= 1;
    if (index < 0) break;
    const previous = ids[index]!;
    for (let move = index; move < runEnd; move += 1) ids[move] = ids[move + 1]!;
    ids[runEnd] = previous;
    changed = true;
    index -= 1;
  }
  return changed;
}

function stablePartition(
  ids: string[],
  selectedIds: ReadonlySet<string>,
  selectedLast: boolean,
): boolean {
  const selected: string[] = [];
  let writeIndex = 0;
  for (const id of ids) {
    if (selectedIds.has(id)) selected.push(id);
    else ids[writeIndex++] = id;
  }
  if (selected.length === 0 || selected.length === ids.length) return false;
  if (selectedLast) {
    for (const id of selected) ids[writeIndex++] = id;
    return true;
  }
  for (let index = ids.length - selected.length - 1; index >= 0; index -= 1) {
    ids[index + selected.length] = ids[index]!;
  }
  for (let index = 0; index < selected.length; index += 1) ids[index] = selected[index]!;
  return true;
}
