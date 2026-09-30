import type { StrokeShapeCache } from "./stroke-shape-cache";
import { isHighlightElement } from "../../domain/commands/render-bands";
import { calculateElementBounds } from "../../domain/geometry/public";
import type { InkElementV1 } from "../../domain/schema/public";
import { escapeXmlText } from "../documents/xml-text";
import { serializeCanonicalElementMetadata } from "./canonical-element-fragments";
import { encodedByteLength } from "./encoded-byte-budget";
import { serializedPathDataByteLength, serializeElementPaths, serializeParts } from "./path-markup";

export interface ElementFragments {
  readonly bottom: number;
  readonly bytes: number;
  readonly canonicalMetadata: string;
  readonly canonicalMetadataBytes: number;
  readonly canonicalMetadataUtf8: Uint8Array<ArrayBuffer>;
  readonly element: InkElementV1;
  readonly metadata: string;
  readonly metadataBytes: number;
  readonly pathDataBytes: number;
  readonly retainedBytes: number;
  readonly svg: string;
}

export type RenderBand = "content" | "highlight";

export function elementRenderBand(element: InkElementV1): RenderBand {
  return isHighlightElement(element) ? "highlight" : "content";
}

export function buildElementFragments(
  element: InkElementV1,
  bottom = calculateElementBounds(element).maxY,
  shapeCache?: StrokeShapeCache,
): ElementFragments {
  const canonicalMetadata = serializeCanonicalElementMetadata(element);
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
  const canonicalMetadataUtf8 = new TextEncoder().encode(canonicalMetadata);
  const canonicalMetadataBytes = canonicalMetadataUtf8.byteLength;
  const metadataBytes = encodedByteLength(metadata);
  const bytes = metadataBytes + encodedByteLength(svg);
  return {
    bottom,
    bytes,
    canonicalMetadata,
    canonicalMetadataBytes,
    canonicalMetadataUtf8,
    element,
    metadata,
    metadataBytes,
    pathDataBytes,
    retainedBytes:
      bytes +
      canonicalMetadataUtf8.byteLength +
      (canonicalMetadata === metadata ? 0 : canonicalMetadataBytes),
    svg,
  };
}
