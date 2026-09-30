import type { InkSnapshotV1 } from "../../domain/schema/public";
import { canonicalMetadataText, metadataSha256 } from "../serialization/canonical-metadata";
import { COMPACT_METADATA_ENCODING } from "../serialization/stroke-sample-codec";
import { serializeSvgNumber } from "./svg-number";
import { CANONICAL_THEME_STYLESHEET } from "./svg-theme";
import { escapeXmlText } from "./xml-text";

export interface StaticSvgBands {
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
    `data-inkbook-format="inkbook" data-inkbook-version="1" ` +
    `data-inkbook-revision="${snapshot.revision}" ` +
    `data-inkbook-snapshot-sha256="${metadataHash}">` +
    `<style id="inkbook-theme">${CANONICAL_THEME_STYLESHEET}</style>` +
    `<metadata id="inkbook-snapshot" data-encoding="${COMPACT_METADATA_ENCODING}">${metadata}</metadata>` +
    `<g id="inkbook-background">${joinPaths(bands.background)}</g>` +
    `<g id="inkbook-highlights">${joinPaths(bands.highlights)}</g>` +
    `<g id="inkbook-content">${joinPaths(bands.content)}</g>` +
    "</svg>"
  );
}
