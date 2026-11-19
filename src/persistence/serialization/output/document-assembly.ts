import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../../domain/schema/public";
import { RENDER_BANDS } from "../../../domain/commands/render-bands";
import {
  elementMinimumSnapshotVersion,
  elementSnapshotVersion,
} from "../../../domain/schema/snapshot-version";
import { serializeSvgNumber } from "../../documents/svg-number";
import { CANONICAL_THEME_STYLESHEET } from "../../documents/svg-theme";
import { escapeXmlText } from "../../documents/xml-text";
import { metadataPrefix as canonicalMetadataPrefix } from "../metadata/canonical-metadata";
import { encodedByteLength } from "./encoded-byte-budget";
import { COMPACT_METADATA_ENCODING } from "../metadata/stroke-sample-codec";
import { imageDefinitionsFragments } from "./image-markup";
import { canonicalFontResource, fontStylesheetMarkupFragments } from "./text-fonts";
import { canonicalImageResource } from "../../images/image-resources";
import { usedImageResourcesSteps } from "../../images/used-image-resources";
import { usedFontResourcesSteps } from "../../fonts/used-font-resources";

interface FragmentAssembly<T> {
  readonly snapshot?: InkSnapshotV1;
  readonly image?: Iterable<T>;
  readonly content: Iterable<T>;
  readonly highlight: Iterable<T>;
  readonly metadata: Iterable<T>;
}

export function snapshotMetadata(
  revision: number,
  page: PageV1,
  elements: readonly string[],
  snapshot?: InkSnapshotV1,
): string {
  return `${snapshotMetadataPrefix(revision, page, snapshot)}${elements.join(",")}]}`;
}

export function snapshotMetadataPrefix(
  revision: number,
  page: PageV1,
  snapshot?: InkSnapshotV1,
): string {
  return escapeXmlText(canonicalMetadataPrefix(revision, page, snapshot));
}

export function documentUtf8Fragments(
  revision: number,
  lockedHeight: number,
  metadataPrefix: string,
  metadataHash: string,
  assembly: FragmentAssembly<Uint8Array>,
  background: string,
): Iterable<Uint8Array> {
  const encoder = new TextEncoder();
  return assembleDocumentFragments(
    { background, lockedHeight, metadataHash, metadataPrefix, revision },
    assembly,
    (text) => encoder.encode(text),
  );
}

function* assembleDocumentFragments<T>(
  envelope: Readonly<{
    background: string;
    lockedHeight: number;
    metadataHash: string;
    metadataPrefix: string;
    revision: number;
  }>,
  assembly: FragmentAssembly<T>,
  encode: (text: string) => T,
): Iterable<T> {
  for (const fragment of rootFragments(
    envelope.revision,
    envelope.lockedHeight,
    envelope.metadataHash,
    assembly.snapshot,
  ))
    yield encode(fragment);
  yield encode(envelope.metadataPrefix);
  const separator = encode(",");
  let firstMetadata = true;
  for (const metadata of assembly.metadata) {
    if (!firstMetadata) yield separator;
    yield metadata;
    firstMetadata = false;
  }
  yield encode(`]}</metadata><g id="inkbook-background">`);
  yield encode(envelope.background);
  if ((assembly.snapshot?.version ?? 1) >= 3) {
    yield encode(`</g><g id="inkbook-images-band">`);
    yield* assembly.image ?? [];
  }
  yield encode(`</g><g id="inkbook-highlights">`);
  yield* assembly.highlight;
  yield encode(`</g><g id="inkbook-content">`);
  yield* assembly.content;
  yield encode("</g></svg>");
}

export function documentStaticByteLength(
  revision: number,
  lockedHeight: number,
  metadataPrefix: string,
  background: string,
  snapshot?: InkSnapshotV1,
): number {
  return [
    // All trusted envelope, CSS and Base64 resource tokens are ASCII.
    "",
    metadataPrefix,
    `]}</metadata><g id="inkbook-background">`,
    background,
    ...((snapshot?.version ?? 1) >= 3 ? [`</g><g id="inkbook-images-band">`] : []),
    `</g><g id="inkbook-highlights">`,
    `</g><g id="inkbook-content">`,
    "</g></svg>",
  ].reduce(
    (bytes, fragment) => bytes + encodedByteLength(fragment),
    [...rootFragments(revision, lockedHeight, "0".repeat(64), snapshot)].reduce(
      (bytes, fragment) => bytes + fragment.length,
      0,
    ),
  );
}

export function snapshotValue(
  revision: number,
  page: PageV1,
  elements: readonly InkElementV1[],
  fontResources?: InkSnapshotV1["fontResources"],
  imageResources?: InkSnapshotV1["imageResources"],
): InkSnapshotV1 {
  return {
    elements: [...elements],
    format: "inkbook",
    page,
    revision,
    version: elementSnapshotVersion(elements),
    ...(imageResources === undefined || imageResources.length === 0
      ? {}
      : { imageResources: [...imageResources] }),
    ...(fontResources === undefined || fontResources.length === 0
      ? {}
      : { fontResources: [...fontResources] }),
  };
}

interface OrderedSnapshotSource {
  readonly revision: number;
  readonly page: PageV1;
  readonly elements: ReadonlyMap<string, InkElementV1>;
  readonly orders: Readonly<{
    image: readonly string[];
    highlight: readonly string[];
    content: readonly string[];
  }>;
  readonly fontResources: NonNullable<InkSnapshotV1["fontResources"]>;
  readonly imageResources: NonNullable<InkSnapshotV1["imageResources"]>;
}

/** Materialize canonical band order while collecting only the elements that bind resources. */
export function* orderedSnapshotValueSteps(
  source: OrderedSnapshotSource,
): Generator<void, InkSnapshotV1> {
  const elements: InkElementV1[] = [];
  const text: InkElementV1[] = [];
  const images: InkElementV1[] = [];
  let version: InkSnapshotV1["version"] = 1;
  for (const band of RENDER_BANDS) {
    for (const id of source.orders[band]) {
      const element = source.elements.get(id)!;
      elements.push(element);
      if (element.kind === "text") text.push(element);
      if (element.kind === "image") images.push(element);
      if (version < 5) {
        const required = elementMinimumSnapshotVersion(element);
        if (required > version) version = required;
      }
      if (elements.length % 256 === 0) yield;
    }
  }
  const fonts = yield* usedFontResourcesSteps(text, source.fontResources);
  const rasters = yield* usedImageResourcesSteps(images, source.imageResources);
  return {
    elements,
    format: "inkbook",
    page: source.page,
    revision: source.revision,
    version,
    ...(fonts.length === 0 ? {} : { fontResources: fonts.map(canonicalFontResource) }),
    ...(rasters.length === 0 ? {} : { imageResources: rasters.map(canonicalImageResource) }),
  };
}

export function envelope(
  revision: number,
  lockedHeight: number,
  metadata: Readonly<{ hash: string; text: string; snapshot?: InkSnapshotV1; images?: string }>,
  background: string,
  highlights: string,
  content: string,
): string {
  return (
    `${rootPrefix(revision, lockedHeight, metadata.hash, metadata.snapshot)}${metadata.text}</metadata>` +
    `<g id="inkbook-background">${background}</g>` +
    ((metadata.snapshot?.version ?? 1) >= 3
      ? `<g id="inkbook-images-band">${metadata.images ?? ""}</g>`
      : "") +
    `<g id="inkbook-highlights">${highlights}</g>` +
    `<g id="inkbook-content">${content}</g></svg>`
  );
}

function rootPrefix(
  revision: number,
  lockedHeight: number,
  metadataHash: string,
  snapshot?: InkSnapshotV1,
): string {
  return [...rootFragments(revision, lockedHeight, metadataHash, snapshot)].join("");
}

function* rootFragments(
  revision: number,
  lockedHeight: number,
  metadataHash: string,
  snapshot?: InkSnapshotV1,
): Iterable<string> {
  yield (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048.6 ${serializeSvgNumber(lockedHeight)}" ` +
    `data-inkbook-format="inkbook" data-inkbook-version="${snapshot?.version ?? 1}" data-inkbook-revision="${revision}" ` +
    `data-inkbook-snapshot-sha256="${metadataHash}">` +
    `<style id="inkbook-theme">${CANONICAL_THEME_STYLESHEET}</style>`
  );
  yield* fontStylesheetMarkupFragments(snapshot?.fontResources ?? []);
  yield* imageDefinitionsFragments(snapshot?.imageResources ?? []);
  yield `<metadata id="inkbook-snapshot" data-encoding="${COMPACT_METADATA_ENCODING}">`;
}
