import type { ArrangeAction } from "../commands/arrange";
import { renderBandOf, type RenderBand } from "../commands/render-bands";

import type { DeltaBuilder } from "./delta-builder";
import { ElementOrderTree } from "./element-order-tree";
import type { ElementRank, ImmutableInkElement } from "./types";

export class ElementStoreOrdering {
  readonly #bands: Record<RenderBand, ElementOrderTree> = {
    content: new ElementOrderTree(),
    highlight: new ElementOrderTree(),
  };
  readonly #arrangeScratch: string[] = [];

  public sizeOf(band: RenderBand): number {
    return this.#bands[band].size;
  }

  public get nodeVisits(): number {
    return this.#bands.content.nodeVisits + this.#bands.highlight.nodeVisits;
  }

  public resetInstrumentation(): void {
    this.#bands.content.resetInstrumentation();
    this.#bands.highlight.resetInstrumentation();
  }

  public getRank(id: string): ElementRank | undefined {
    for (const band of ["highlight", "content"] as const) {
      const rank = this.#bands[band].rankOf(id);
      if (rank !== undefined) return { band, rank };
    }
    return undefined;
  }

  public insertAt(id: string, band: RenderBand, rank: number): void {
    if (this.getRank(id) !== undefined) throw new RangeError(`Duplicate element ID: ${id}`);
    this.#bands[band].insert(id, rank);
  }

  public remove(id: string): RenderBand | undefined {
    for (const band of ["highlight", "content"] as const) {
      if (this.#bands[band].remove(id)) return band;
    }
    return undefined;
  }

  public materializeBand(band: RenderBand): string[] {
    return [...this.#bands[band].ids()];
  }

  public materializeBands(): Record<RenderBand, string[]> {
    return {
      content: this.materializeBand("content"),
      highlight: this.materializeBand("highlight"),
    };
  }

  public clear(): void {
    this.#bands.content.clear();
    this.#bands.highlight.clear();
  }

  public arrange(
    band: RenderBand,
    selectedIds: ReadonlySet<string>,
    action: ArrangeAction,
    changed: (id: string) => void,
  ): boolean {
    const ids = this.materializeBand(band);
    if (!arrangeIdsInPlace(ids, selectedIds, action, this.#arrangeScratch)) return false;
    return this.reorder(band, ids, changed);
  }

  public reorder(band: RenderBand, ids: readonly string[], changed: (id: string) => void): boolean {
    const previous = this.materializeBand(band);
    let modified = false;
    for (let rank = 0; rank < ids.length; rank += 1) {
      if (previous[rank] === ids[rank]) continue;
      changed(ids[rank]!);
      modified = true;
    }
    if (!modified) return false;
    this.#bands[band].clear();
    for (const id of ids) this.#bands[band].insert(id, this.#bands[band].size);
    return true;
  }

  public insert(
    element: ImmutableInkElement,
    placement: "back" | "front",
    delta: DeltaBuilder,
  ): void {
    const band = renderBandOf(element);
    this.insertAt(element.id, band, placement === "front" ? this.sizeOf(band) : 0);
    delta.dirtyBand(band);
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

function arrangeIdsInPlace(
  ids: string[],
  selectedIds: ReadonlySet<string>,
  action: ArrangeAction,
  partitionScratch: string[] = [],
): boolean {
  if (ids.length < 2 || selectedIds.size === 0) return false;
  switch (action) {
    case "bring-forward":
      return bringForward(ids, selectedIds);
    case "send-backward":
      return sendBackward(ids, selectedIds);
    case "bring-to-front":
      return stablePartition(ids, selectedIds, true, partitionScratch);
    case "send-to-back":
      return stablePartition(ids, selectedIds, false, partitionScratch);
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
  selected: string[],
): boolean {
  selected.length = 0;
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
