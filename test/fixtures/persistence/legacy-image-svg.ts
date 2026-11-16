import { derivePageExtent } from "../../../src/domain/geometry/public";
import { serializeSvgEnvelope } from "../../../src/persistence/documents/svg-envelope";
import { escapeXmlText } from "../../../src/persistence/documents/xml-text";
import { serializeBackgroundPaths } from "../../../src/persistence/serialization/output/background";
import { serializeElementPaths } from "../../../src/persistence/serialization/output/path-markup";
import { serializeImageMarkup } from "../../../src/persistence/serialization/output/image-markup";
import {
  canonicalMetadataText,
  metadataSha256,
} from "../../../src/persistence/serialization/metadata/canonical-metadata";
import { imageElement } from "../domain/images";
import { rasterResource } from "./image-svg";
import { createTestStroke, createWorkerSnapshot } from "./worker-snapshot";
import type { FontResourceV2, TextElementV2 } from "../../../src/domain/schema/public";

/** Historical image envelopes retain their original metadata version and ordinary theme paint. */
export function legacyImageDocument(
  version: 3 | 4,
  text?: { element: TextElementV2; font: FontResourceV2 },
): {
  readonly bytes: Uint8Array;
  readonly svg: string;
} {
  const resource = rasterResource();
  const image = {
    ...imageElement(),
    assetId: resource.id,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    ...(version === 4 ? { locked: true } : {}),
  };
  const annotation = createTestStroke();
  const snapshot = {
    ...createWorkerSnapshot([image, annotation, ...(text === undefined ? [] : [text.element])], 7),
    version,
    imageResources: [resource],
    ...(text === undefined ? {} : { fontResources: [text.font] }),
  };
  const height = derivePageExtent(snapshot.page, image.y + image.height).lockedHeight;
  const envelope = serializeSvgEnvelope(snapshot, height, {
    background: serializeBackgroundPaths(snapshot.page.background, height),
    images: [serializeImageMarkup(image)],
    highlights: [],
    content: [
      ...serializeElementPaths(annotation),
      ...(text === undefined ? [] : serializeElementPaths(text.element)),
    ],
  });
  const metadata = canonicalMetadataText(snapshot).replace('"version":5', `"version":${version}`);
  const svg = envelope
    .replace(
      /data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u,
      `data-inkbook-snapshot-sha256="${metadataSha256(metadata)}"`,
    )
    .replace(
      /(<metadata [^>]*>)[\s\S]*?(<\/metadata>)/u,
      (_match, opening: string, closing: string) => opening + escapeXmlText(metadata) + closing,
    );
  return { bytes: new TextEncoder().encode(svg), svg };
}
