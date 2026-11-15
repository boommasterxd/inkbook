import { imageDefinitionsMarkup } from "../serialization/output/image-markup";
import type { ImageElementV3, InkSnapshotV1 } from "../../domain/schema/public";
import {
  canonicalMetadataText,
  metadataSha256,
} from "../serialization/metadata/canonical-metadata";
import { COMPACT_METADATA_ENCODING } from "../serialization/metadata/stroke-sample-codec";
import { serializeSvgNumber } from "./svg-number";
import { CANONICAL_THEME_STYLESHEET } from "./svg-theme";
import { escapeXmlText } from "./xml-text";
import { fontStylesheetMarkup } from "../serialization/output/text-fonts";
import { autoDefinitionsFragments } from "../serialization/output/auto-contrast-definitions";
import {
  autoPaintDefinitionsFragments,
  type AutoPaintServerRegistry,
} from "../serialization/output/auto-contrast-servers";

export interface StaticSvgBands {
  readonly autoPaints?: AutoPaintServerRegistry | undefined;
  readonly underlayImages?: readonly ImageElementV3[];
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
    [...autoDefinitionsFragments(snapshot, lockedHeight, bands.underlayImages)].join("") +
    [...autoPaintDefinitionsFragments(snapshot, bands.autoPaints, bands.underlayImages)].join("") +
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
