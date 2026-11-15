import { imageDefinitionsMarkup } from "../serialization/output/image-markup";
import type { InkSnapshotV1 } from "../../domain/schema/public";
import {
  canonicalMetadataText,
  metadataSha256,
} from "../serialization/metadata/canonical-metadata";
import { COMPACT_METADATA_ENCODING } from "../serialization/metadata/stroke-sample-codec";
import { serializeSvgNumber } from "./svg-number";
import { CANONICAL_THEME_STYLESHEET } from "./svg-theme";
import { escapeXmlText } from "./xml-text";
import { fontStylesheetMarkup } from "../serialization/output/text-fonts";

export interface StaticSvgBands {
  readonly images?: readonly string[];
  readonly background: readonly string[];
  readonly highlights: readonly string[];
  readonly content: readonly string[];
}

function joinPaths(paths: readonly string[]): string {
  return paths.join("");
}

export function serializeSvgEnvelope(
  snapshot: InkSnapshotV1,
  lockedHeight: number,
  bands: StaticSvgBands,
): string {
  const height = serializeSvgNumber(lockedHeight);
  const metadataText = canonicalMetadataText(snapshot);
  const metadata = escapeXmlText(metadataText);
  const metadataHash = metadataSha256(metadataText);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048.6 ${height}" ` +
    `data-inkbook-format="inkbook" data-inkbook-version="${snapshot.version}" ` +
    `data-inkbook-revision="${snapshot.revision}" ` +
    `data-inkbook-snapshot-sha256="${metadataHash}">` +
    `<style id="inkbook-theme">${CANONICAL_THEME_STYLESHEET}</style>` +
    fontStylesheetMarkup(snapshot.fontResources ?? []) +
    imageDefinitionsMarkup(snapshot.imageResources ?? []) +
    `<metadata id="inkbook-snapshot" data-encoding="${COMPACT_METADATA_ENCODING}">${metadata}</metadata>` +
    `<g id="inkbook-background">${joinPaths(bands.background)}</g>` +
    (snapshot.version >= 3
      ? `<g id="inkbook-images-band">${joinPaths(bands.images ?? [])}</g>`
      : "") +
    `<g id="inkbook-highlights">${joinPaths(bands.highlights)}</g>` +
    `<g id="inkbook-content">${joinPaths(bands.content)}</g>` +
    "</svg>"
  );
}
