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
    if (retained !== undefined) output[count++] = retained;
    if (previousIndex >= previousCount && retained === undefined) {
      while (entrantIndex < entrants.length) output[count++] = entrants[entrantIndex++]!;
    }
  }
  return count;
}
import type { MountedSceneElement } from "./mounted-element";

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
