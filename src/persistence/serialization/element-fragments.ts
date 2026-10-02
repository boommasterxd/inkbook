import type { StrokeShapeCache } from "./stroke-shape-cache";
import type { StrokeSampleEncodingCache } from "./stroke-sample-encoding-cache";
import { isHighlightElement } from "../../domain/commands/render-bands";
import { calculateElementBounds } from "../../domain/geometry/public";
import type { InkElementV1 } from "../../domain/schema/public";
import { escapeXmlText } from "../documents/xml-text";
import { serializeCanonicalElementMetadata } from "./canonical-element-fragments";
import { serializedPathDataByteLength, serializeElementPaths, serializeParts } from "./path-markup";

const decoder = new TextDecoder();

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
  const canonicalMetadata = serializeCanonicalElementMetadata(element, sampleCache);
  const metadata = escapeXmlText(canonicalMetadata);
  const svg = (
    element.kind === "stroke" && shapeCache !== undefined
      ? serializeParts(element, shapeCache.resolve(element))
      : serializeElementPaths(element)
  ).join("");
  return elementFragments(
    element,
    canonicalMetadata,
    metadata,
    svg,
    serializedPathDataByteLength(svg),
    bottom,
  );
}

function elementFragments(
  element: InkElementV1,
  canonicalMetadata: string,
  metadata: string,
  svg: string,
  pathDataBytes: number,
  bottom: number,
): ElementFragments {
  const encoder = new TextEncoder();
  const canonicalMetadataUtf8 = encoder.encode(canonicalMetadata);
  const canonicalMetadataBytes = canonicalMetadataUtf8.byteLength;
  const metadataUtf8 =
    canonicalMetadata === metadata ? canonicalMetadataUtf8 : encoder.encode(metadata);
  const svgUtf8 = encoder.encode(svg);
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
    pathDataBytes,
    retainedBytes: bytes + (metadataUtf8 === canonicalMetadataUtf8 ? 0 : canonicalMetadataBytes),
    get svg() {
      return decoder.decode(svgUtf8);
    },
    svgUtf8,
  };
}
