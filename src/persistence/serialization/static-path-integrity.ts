import { deriveRenderBands } from "../../domain/commands/render-bands";
import type { BackgroundV1, InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";
import type { SafeSvgGroupRange, SafeSvgValidation } from "../documents/safe-svg-validator";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "../documents/svg-output-limits";

import {
  backgroundFitsStaticLimit,
  serializeBackgroundPaths,
  serializeLegacyCenteredBackgroundPaths,
  serializePreviousInsetBackgroundPaths,
  serializePreviousTopAnchoredBackgroundPaths,
} from "./background";
import { serializeElementPaths } from "./path-markup";

const DEFAULT_FRAGMENTS_PER_STEP = 128;

interface StaticPathIntegrityStepOptions {
  readonly fragmentsPerStep?: number;
}

export function verifyStaticPathIntegrity(
  svg: string,
  safe: SafeSvgValidation,
  snapshot: InkSnapshotV1,
): StaticPathIntegrityResult | null {
  return completeVerification(verifyStaticPathIntegritySteps(svg, safe, snapshot));
}

export interface StaticPathIntegrityResult {
  readonly requiresCanonicalRewrite: boolean;
}

/** Compares canonical derived path fragments without copying the supplied SVG group contents. */
function* verifyStaticPathIntegritySteps(
  svg: string,
  safe: SafeSvgValidation,
  snapshot: InkSnapshotV1,
  options: StaticPathIntegrityStepOptions = {},
): Generator<void, StaticPathIntegrityResult | null> {
  const fragmentsPerStep = options.fragmentsPerStep ?? DEFAULT_FRAGMENTS_PER_STEP;
  if (!Number.isSafeInteger(fragmentsPerStep) || fragmentsPerStep < 1) return null;
  if (
    !backgroundFitsStaticLimit(
      snapshot.page.background,
      safe.lockedHeight,
      MAXIMUM_TOTAL_PATH_DATA_BYTES,
    )
  ) {
    return null;
  }

  const currentBackground = yield* verifyGroupFragments(
    svg,
    safe.groups.background,
    serializeBackgroundPaths(snapshot.page.background, safe.lockedHeight),
    fragmentsPerStep,
  );
  const historicalBackground =
    !currentBackground && snapshot.page.background.type !== "none"
      ? yield* verifyHistoricalBackground(
          svg,
          safe.groups.background,
          snapshot.page.background,
          safe.lockedHeight,
          fragmentsPerStep,
        )
      : false;
  if (!currentBackground && !historicalBackground) return null;

  const bands = deriveRenderBands(snapshot.elements);
  const groups: readonly [SafeSvgGroupRange, Iterable<string>][] = [
    [safe.groups.highlights, elementPathFragments(bands.highlight)],
    [safe.groups.content, elementPathFragments(bands.content)],
  ];

  for (const [range, fragments] of groups) {
    if (!(yield* verifyGroupFragments(svg, range, fragments, fragmentsPerStep))) return null;
  }
  return { requiresCanonicalRewrite: !currentBackground };
}

function* verifyHistoricalBackground(
  svg: string,
  range: SafeSvgGroupRange,
  background: Exclude<BackgroundV1, { type: "none" }>,
  lockedHeight: number,
  fragmentsPerStep: number,
): Generator<void, boolean> {
  const serializers = [
    serializePreviousInsetBackgroundPaths,
    serializePreviousTopAnchoredBackgroundPaths,
    serializeLegacyCenteredBackgroundPaths,
  ] as const;
  for (const serialize of serializers) {
    const fragments = serialize(background, lockedHeight);
    if (yield* verifyGroupFragments(svg, range, fragments, fragmentsPerStep)) return true;
  }
  return false;
}

function* verifyGroupFragments(
  svg: string,
  range: SafeSvgGroupRange,
  fragments: Iterable<string>,
  fragmentsPerStep: number,
): Generator<void, boolean> {
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

function completeVerification(
  steps: Generator<void, StaticPathIntegrityResult | null>,
): StaticPathIntegrityResult | null {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
