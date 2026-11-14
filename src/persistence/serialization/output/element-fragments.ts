import { prepareStrokeShapeSteps, type StrokeShapeCache } from "./stroke-shape-cache";
import type { StrokeSampleEncodingCache } from "../metadata/stroke-sample-encoding-cache";
import type { StrokeFragmentPathRange } from "./stroke-fragment-paths";
import { isHighlightElement } from "../../../domain/commands/render-bands";
import { calculateElementBounds } from "../../../domain/geometry/public";
import type { InkElementV1 } from "../../../domain/schema/public";
import { escapeXmlText } from "../../documents/xml-text";
import { serializeTextMarkup } from "./text-markup";
import {
  serializeCanonicalElementMetadata,
  serializeCanonicalElementMetadataSteps,
} from "../metadata/canonical-element-fragments";
import { serializedPathDataByteLength, serializeElementPaths, serializeParts } from "./path-markup";

const decoder = new TextDecoder();
interface FragmentEncoding {
  readonly canonicalMetadataUtf8: Uint8Array<ArrayBuffer>;
  readonly metadataUtf8: Uint8Array<ArrayBuffer>;
  readonly svgUtf8: Uint8Array<ArrayBuffer>;
}

export interface ElementFragments {
  readonly bottom: number;
  readonly bytes: number;
  readonly canonicalMetadata: string;
  readonly canonicalMetadataBytes: number;
  readonly canonicalMetadataUtf8: Uint8Array<ArrayBuffer>;
  readonly element: InkElementV1;
  readonly metadata: string;
  readonly metadataBytes: number;
  readonly metadataUtf8: Uint8Array<ArrayBuffer>;
  readonly pathDataBytes: number;
  readonly retainedBytes: number;
  readonly svg: string;
  readonly svgUtf8: Uint8Array<ArrayBuffer>;
  readonly strokePaths: readonly StrokeFragmentPathRange[] | undefined;
}

export type RenderBand = "content" | "highlight";

export function elementRenderBand(element: InkElementV1): RenderBand {
  return isHighlightElement(element) ? "highlight" : "content";
}

export function buildElementFragments(
  element: InkElementV1,
  bottom = calculateElementBounds(element).maxY,
  shapeCache?: StrokeShapeCache,
  sampleCache?: StrokeSampleEncodingCache,
): ElementFragments {
  const steps = elementFragmentSteps(element, bottom, shapeCache, sampleCache, undefined, true);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Yield markers offer scheduler checkpoints; they never require a task handoff. */
export function* buildElementFragmentsSteps(
  element: InkElementV1,
  bottom: number,
  shapeCache?: StrokeShapeCache,
  sampleCache?: StrokeSampleEncodingCache,
  signal?: AbortSignal,
): Generator<void, ElementFragments> {
  return yield* elementFragmentSteps(element, bottom, shapeCache, sampleCache, signal, false);
}

function* elementFragmentSteps(
  element: InkElementV1,
  bottom: number,
  shapeCache: StrokeShapeCache | undefined,
  sampleCache: StrokeSampleEncodingCache | undefined,
  signal: AbortSignal | undefined,
  synchronous: boolean,
): Generator<void, ElementFragments> {
  signal?.throwIfAborted();
  const canonicalMetadata = synchronous
    ? serializeCanonicalElementMetadata(element, sampleCache)
    : yield* serializeCanonicalElementMetadataSteps(element, sampleCache, signal);
  const metadata =
    element.kind === "text"
      ? yield* escapedTextSteps(canonicalMetadata, signal)
      : escapeXmlText(canonicalMetadata);
  const parts =
    element.kind === "stroke"
      ? shapeCache === undefined
        ? yield* prepareStrokeShapeSteps(element, signal)
        : synchronous
          ? shapeCache.resolve(element)
          : yield* shapeCache.resolveSteps(element, signal)
      : undefined;
  signal?.throwIfAborted();
  const svg =
    element.kind === "text"
      ? yield* textMarkupSteps(element, signal)
      : (parts === undefined
          ? serializeElementPaths(element)
          : serializeParts(element, parts)
        ).join("");
  const offsets = parts === undefined ? undefined : ([] as number[]);
  const bytes = serializedPathDataByteLength(svg, offsets);
  const ranges = parts?.map((part, index): StrokeFragmentPathRange => {
    if (part.paint === "fill-and-stroke") throw new Error("Invalid stroke path paint.");
    return { start: offsets![index * 2]!, end: offsets![index * 2 + 1]!, paint: part.paint };
  });
  const encoding =
    element.kind === "text"
      ? {
          canonicalMetadataUtf8: yield* encodeTextSteps(canonicalMetadata, signal),
          metadataUtf8: yield* encodeTextSteps(metadata, signal),
          svgUtf8: yield* encodeTextSteps(svg, signal),
        }
      : undefined;
  return elementFragments(
    element,
    canonicalMetadata,
    metadata,
    svg,
    { bytes, ranges, encoding },
    bottom,
  );
}

function* encodeTextSteps(
  text: string,
  signal?: AbortSignal,
): Generator<void, Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + 16 * 1024);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    const chunk = encoder.encode(text.slice(start, end));
    chunks.push(chunk);
    bytes += chunk.byteLength;
    start = end;
    signal?.throwIfAborted();
    yield;
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
    signal?.throwIfAborted();
    yield;
  }
  return result;
}

function* escapedTextSteps(input: string, signal?: AbortSignal): Generator<void, string> {
  const chunks: string[] = [];
  for (let start = 0; start < input.length; start += 16 * 1024) {
    chunks.push(escapeXmlText(input.slice(start, start + 16 * 1024)));
    signal?.throwIfAborted();
    yield;
  }
  return chunks.join("");
}

function* textMarkupSteps(
  element: Extract<InkElementV1, { kind: "text" }>,
  signal?: AbortSignal,
): Generator<void, string> {
  const chunks: string[] = [];
  for (const fragment of serializeTextMarkup(element)) {
    chunks.push(fragment);
    signal?.throwIfAborted();
    yield;
  }
  return chunks.join("");
}

function elementFragments(
  element: InkElementV1,
  canonicalMetadata: string,
  metadata: string,
  svg: string,
  paths: {
    readonly bytes: number;
    readonly ranges: readonly StrokeFragmentPathRange[] | undefined;
    readonly encoding?: FragmentEncoding | undefined;
  },
  bottom: number,
): ElementFragments {
  const encoder = new TextEncoder();
  const canonicalMetadataUtf8 =
    paths.encoding?.canonicalMetadataUtf8 ?? encoder.encode(canonicalMetadata);
  const canonicalMetadataBytes = canonicalMetadataUtf8.byteLength;
  const metadataUtf8 =
    paths.encoding?.metadataUtf8 ??
    (canonicalMetadata === metadata ? canonicalMetadataUtf8 : encoder.encode(metadata));
  const svgUtf8 = paths.encoding?.svgUtf8 ?? encoder.encode(svg);
  const metadataBytes = metadataUtf8.byteLength;
  const bytes = metadataBytes + svgUtf8.byteLength;
  return {
    bottom,
    bytes,
    get canonicalMetadata() {
      return decoder.decode(canonicalMetadataUtf8);
    },
    canonicalMetadataBytes,
    canonicalMetadataUtf8,
    element,
    get metadata() {
      return decoder.decode(metadataUtf8);
    },
    metadataBytes,
    metadataUtf8,
    pathDataBytes: paths.bytes,
    retainedBytes:
      bytes +
      (metadataUtf8 === canonicalMetadataUtf8 ? 0 : canonicalMetadataBytes) +
      (paths.ranges === undefined ? 0 : 48 + paths.ranges.length * 64),
    get svg() {
      return decoder.decode(svgUtf8);
    },
    svgUtf8,
    strokePaths: paths.ranges,
  };
}
