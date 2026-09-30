import type { InkElementV1 } from "../../domain/schema/public";
import { canonicalElement } from "./canonical-snapshot";
import { encodeStrokeSamples } from "./stroke-sample-codec";

export function serializeCanonicalElementMetadata(element: InkElementV1): string {
  const canonical = canonicalElement(element, true);
  return JSON.stringify(
    canonical.kind === "stroke"
      ? { ...canonical, points: encodeStrokeSamples(canonical.points) }
      : canonical,
  );
}

/** Avoid materializing or stringifying an entire long runtime stroke in one task. */
export function* canonicalElementFragments(element: InkElementV1): Iterable<string> {
  if (element.kind !== "stroke") {
    yield JSON.stringify(canonicalElement(element));
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
