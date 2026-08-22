import { deriveRenderBands } from "../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";
import type { SafeSvgGroupRange, SafeSvgValidation } from "../documents/safe-svg-validator";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "../documents/svg-output-limits";

import { backgroundFitsStaticLimit, serializeBackgroundPaths } from "./background";
import { serializeElementPaths } from "./path-markup";

const DEFAULT_FRAGMENTS_PER_STEP = 128;

interface StaticPathIntegrityStepOptions {
  readonly fragmentsPerStep?: number;
}

export function verifyStaticPathIntegrity(
  svg: string,
  safe: SafeSvgValidation,
  snapshot: InkSnapshotV1,
): boolean {
  return completeVerification(verifyStaticPathIntegritySteps(svg, safe, snapshot));
}

/** Compares canonical derived path fragments without copying the supplied SVG group contents. */
function* verifyStaticPathIntegritySteps(
  svg: string,
  safe: SafeSvgValidation,
  snapshot: InkSnapshotV1,
  options: StaticPathIntegrityStepOptions = {},
): Generator<void, boolean> {
  const fragmentsPerStep = options.fragmentsPerStep ?? DEFAULT_FRAGMENTS_PER_STEP;
  if (!Number.isSafeInteger(fragmentsPerStep) || fragmentsPerStep < 1) return false;
  if (
    !backgroundFitsStaticLimit(
      snapshot.page.background,
      safe.lockedHeight,
      MAXIMUM_TOTAL_PATH_DATA_BYTES,
    )
  ) {
    return false;
  }

  const bands = deriveRenderBands(snapshot.elements);
  const groups: readonly [SafeSvgGroupRange, Iterable<string>][] = [
    [safe.groups.background, serializeBackgroundPaths(snapshot.page.background, safe.lockedHeight)],
    [safe.groups.highlights, elementPathFragments(bands.highlight)],
    [safe.groups.content, elementPathFragments(bands.content)],
  ];

  for (const [range, fragments] of groups) {
    if (!validRange(range, svg.length)) return false;
    let cursor = range.start;
    let fragmentsSinceStep = 0;
    for (const fragment of fragments) {
      if (cursor + fragment.length > range.end || !svg.startsWith(fragment, cursor)) return false;
      cursor += fragment.length;
      fragmentsSinceStep += 1;
      if (fragmentsSinceStep === fragmentsPerStep) {
        fragmentsSinceStep = 0;
        yield;
      }
    }
    if (cursor !== range.end) return false;
    if (fragmentsSinceStep > 0) yield;
  }
  return true;
}

function* elementPathFragments(elements: readonly InkElementV1[]): Iterable<string> {
  for (const element of elements) yield* serializeElementPaths(element);
}

function validRange(range: SafeSvgGroupRange, inputLength: number): boolean {
  return (
    Number.isSafeInteger(range.start) &&
    Number.isSafeInteger(range.end) &&
    range.start >= 0 &&
    range.start <= range.end &&
    range.end <= inputLength
  );
}

function completeVerification(steps: Generator<void, boolean>): boolean {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
