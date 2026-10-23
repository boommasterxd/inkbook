/** Merge newly visible IDs into the retained band order without sorting the full band. */
export function mergeVisibleBand(
  previous: readonly (string | undefined)[],
  previousCount: number,
  entrants: string[],
  output: (string | undefined)[],
  isVisible: (id: string) => boolean,
  compare: (left: string, right: string) => number,
): number {
  entrants.sort(compare);
  let previousIndex = 0;
  let entrantIndex = 0;
  let count = 0;
  while (previousIndex < previousCount || entrantIndex < entrants.length) {
    let retained: string | undefined;
    while (previousIndex < previousCount) {
      const id = previous[previousIndex++];
      if (id !== undefined && isVisible(id)) {
        retained = id;
        break;
      }
    }
    while (
      retained !== undefined &&
      entrantIndex < entrants.length &&
      compare(entrants[entrantIndex]!, retained) < 0
    ) {
      output[count++] = entrants[entrantIndex++]!;
    }
    if (retained !== undefined) {
      // Removal and restoration may share one publication without changing the previous band.
      if (entrants[entrantIndex] === retained) entrantIndex += 1;
      output[count++] = retained;
    }
    if (previousIndex >= previousCount && retained === undefined) {
      while (entrantIndex < entrants.length) output[count++] = entrants[entrantIndex++]!;
    }
  }
  return count;
}

/** Dense rank changes preserve the retained sequence when its current ranks remain ordered. */
export function retainedVisibleOrderStable(
  previous: readonly (string | undefined)[],
  count: number,
  isVisible: (id: string) => boolean,
  rank: (id: string) => number,
): boolean {
  let precedingRank = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const id = previous[index];
    if (id === undefined || !isVisible(id)) continue;
    const currentRank = rank(id);
    if (currentRank <= precedingRank) return false;
    precedingRank = currentRank;
  }
  return true;
}

export function sortVisibleBand(
  ids: (string | undefined)[],
  count: number,
  compare: (left: string | undefined, right: string | undefined) => number,
): void {
  const siftDown = (start: number, length: number): void => {
    let root = start;
    while (root * 2 + 1 < length) {
      const left = root * 2 + 1;
      const right = left + 1;
      const child = right < length && compare(ids[right], ids[left]) > 0 ? right : left;
      if (compare(ids[child], ids[root]) <= 0) return;
      const value = ids[root];
      ids[root] = ids[child];
      ids[child] = value;
      root = child;
    }
  };
  for (let start = Math.floor(count / 2) - 1; start >= 0; start -= 1) siftDown(start, count);
  for (let end = count - 1; end > 0; end -= 1) {
    const first = ids[0];
    ids[0] = ids[end];
    ids[end] = first;
    siftDown(0, end);
  }
}
import type { MountedSceneElement } from "../content/mounted-element";

/** Finds the next retained node for an urgent entrant without reading the store. */
export function firstMountedSuccessor(
  visible: { readonly count: number; readonly ids: readonly (string | undefined)[] },
  id: string,
  mounted: ReadonlyMap<string, MountedSceneElement>,
): MountedSceneElement | undefined {
  let found = false;
  for (let index = 0; index < visible.count; index += 1) {
    const candidate = visible.ids[index]!;
    if (found) {
      const entry = mounted.get(candidate);
      if (entry !== undefined) return entry;
    } else found = candidate === id;
  }
  return undefined;
}
import type { RenderBand } from "../../../domain/commands/render-bands";
import type { SceneStorePort } from "../types";
import type { VisibilityResult } from "./visibility-types";
import type { VisibilityRemovalReuse } from "./visibility-removal";

export function commitVisibleBands(
  ids: Record<RenderBand, readonly (string | undefined)[]>,
  counts: Record<RenderBand, number>,
  visibility: VisibilityResult,
  proof?: {
    readonly mounted: ReadonlyMap<string, MountedSceneElement>;
    readonly store: SceneStorePort;
    readonly epoch: number;
  },
  removalReuse?: VisibilityRemovalReuse,
): void {
  let generation = removalReuse?.beginCommit(visibility);
  for (const band of ["highlight", "content"] as const) {
    const visible = visibility[band];
    ids[band] = visible.ids;
    counts[band] = visible.count;
    if (proof === undefined) continue;
    for (let index = 0; index < visible.count; index += 1) {
      const id = visible.ids[index];
      const entry = id === undefined ? undefined : proof.mounted.get(id);
      const record = entry === undefined ? undefined : proof.store.get(entry.id);
      if (entry !== undefined && record?.band === entry.band && entry.detachedPathCount === 0) {
        entry.committedRank = record.rank;
        entry.committedOrderEpoch = proof.epoch;
        if (generation !== undefined) removalReuse?.updateRank(entry.id, record.rank);
      } else generation = undefined;
    }
  }
  removalReuse?.finishCommit(visibility, generation, proof !== undefined);
}

/** Refreshes cached ranks and reports whether the published band may require sorting. */
export function refreshVisibleRanks(
  ids: readonly (string | undefined)[],
  count: number,
  band: RenderBand,
  store: SceneStorePort,
  slots: ReadonlyMap<string, number>,
  ranks: Float64Array,
): boolean {
  let changed = false;
  for (let index = 0; index < count; index += 1) {
    const id = ids[index];
    if (id === undefined) continue;
    const slot = slots.get(id);
    if (slot === undefined) continue;
    const record = store.get(id);
    if (record?.band !== band) continue;
    const rank = record.rank;
    if (ranks[slot] === rank) continue;
    ranks[slot] = rank;
    changed = true;
  }
  return changed;
}

export function clearVisibleReferences(values: (string | undefined)[], count: number): void {
  for (let index = 0; index < count; index += 1) values[index] = undefined;
}

export function mountedVisibleIds(
  ordered: readonly (string | undefined)[],
  count: number,
  mounted: ReadonlyMap<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = ordered[index];
    if (id !== undefined && mounted.has(id)) ids.push(id);
  }
  return ids;
}
