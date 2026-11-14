import type { InkElementV1 } from "../../../domain/schema/public";
import { canonicalElement } from "./canonical-snapshot";
import { encodeStrokeSamples, encodeStrokeSamplesSteps } from "./stroke-sample-codec";
import type { StrokeSampleEncodingCache } from "./stroke-sample-encoding-cache";
import { boundedJsonFragments } from "./bounded-json-fragments";
import { canonicalTextElementSteps } from "./text-canonical";

export function serializeCanonicalElementMetadata(
  element: InkElementV1,
  sampleCache?: StrokeSampleEncodingCache,
): string {
  const points =
    element.kind === "stroke"
      ? (sampleCache?.resolve(element) ?? encodeStrokeSamples(element.points))
      : undefined;
  const steps = canonicalMetadataSteps(element, points, undefined, undefined);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function* serializeCanonicalElementMetadataSteps(
  element: InkElementV1,
  sampleCache?: StrokeSampleEncodingCache,
  signal?: AbortSignal,
): Generator<void, string> {
  return yield* canonicalMetadataSteps(element, undefined, sampleCache, signal);
}

function* canonicalMetadataSteps(
  element: InkElementV1,
  encoding: string | undefined,
  sampleCache: StrokeSampleEncodingCache | undefined,
  signal: AbortSignal | undefined,
): Generator<void, string> {
  signal?.throwIfAborted();
  if (element.kind === "text") {
    const fragments: string[] = [];
    let pending = 0;
    const canonical = yield* canonicalTextElementSteps(element, signal);
    for (const fragment of boundedJsonFragments(canonical)) {
      fragments.push(fragment);
      pending += fragment.length;
      if (pending >= 16 * 1024) {
        signal?.throwIfAborted();
        yield;
        pending = 0;
      }
    }
    return fragments.join("");
  }
  if (element.kind !== "stroke") return JSON.stringify(canonicalElement(element));
  const canonical = canonicalElement({ ...element, points: [] });
  const points =
    encoding ??
    (sampleCache === undefined
      ? yield* encodeStrokeSamplesSteps(element.points, signal)
      : yield* sampleCache.resolveSteps(element, signal));
  signal?.throwIfAborted();
  return JSON.stringify({ ...canonical, points });
}

/** Avoid materializing or stringifying an entire long runtime stroke in one task. */
export function* canonicalElementFragments(element: InkElementV1): Iterable<string> {
  if (element.kind !== "stroke") {
    if (element.kind === "text") {
      const steps = canonicalTextElementSteps(element);
      let step = steps.next();
      while (!step.done) {
        yield "";
        step = steps.next();
      }
      let chunks: string[] = [];
      let characters = 0;
      for (const fragment of boundedJsonFragments(step.value)) {
        chunks.push(fragment);
        characters += fragment.length;
        if (characters >= 16 * 1024) {
          yield chunks.join("");
          chunks = [];
          characters = 0;
        }
      }
      if (chunks.length > 0) yield chunks.join("");
    } else yield JSON.stringify(canonicalElement(element));
    return;
  }
  const { prefix, suffix } = canonicalStrokeMetadataFrame(element);
  yield prefix;
  yield* canonicalStrokeSampleFragments(element.points);
  yield suffix;
}

export function canonicalStrokeMetadataFrame(element: Extract<InkElementV1, { kind: "stroke" }>): {
  prefix: string;
  suffix: string;
} {
  const canonical = canonicalElement({ ...element, points: [] });
  const template = JSON.stringify({ ...canonical, points: "" });
  const marker = '"points":""';
  const offset = template.indexOf(marker) + marker.length - 1;
  return { prefix: template.slice(0, offset), suffix: template.slice(offset) };
}

export function* canonicalStrokeSampleFragments(points: ArrayLike<number>): Iterable<string> {
  const encoded = encodeStrokeSamples(points);
  for (let start = 0; start < encoded.length; start += 64 * 1024) {
    yield encoded.slice(start, start + 64 * 1024);
  }
}
