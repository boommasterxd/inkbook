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
