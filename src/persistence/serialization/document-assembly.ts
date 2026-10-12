import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../domain/schema/public";
import { serializeSvgNumber } from "../documents/svg-number";
import { CANONICAL_THEME_STYLESHEET } from "../documents/svg-theme";
import { escapeXmlText } from "../documents/xml-text";
import { metadataPrefix as canonicalMetadataPrefix } from "./canonical-metadata";
import { encodedByteLength } from "./encoded-byte-budget";
import { COMPACT_METADATA_ENCODING } from "./stroke-sample-codec";

interface FragmentAssembly<T> {
  readonly content: Iterable<T>;
  readonly highlight: Iterable<T>;
  readonly metadata: Iterable<T>;
}

export function snapshotMetadata(
  revision: number,
  page: PageV1,
  elements: readonly string[],
): string {
  return `${snapshotMetadataPrefix(revision, page)}${elements.join(",")}]}`;
}

export function snapshotMetadataPrefix(revision: number, page: PageV1): string {
  return escapeXmlText(canonicalMetadataPrefix(revision, page));
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
  yield encode(rootPrefix(envelope.revision, envelope.lockedHeight, envelope.metadataHash));
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
): number {
  return [
    rootPrefix(revision, lockedHeight, "0".repeat(64)),
    metadataPrefix,
    `]}</metadata><g id="inkbook-background">`,
    background,
    `</g><g id="inkbook-highlights">`,
    `</g><g id="inkbook-content">`,
    "</g></svg>",
  ].reduce((bytes, fragment) => bytes + encodedByteLength(fragment), 0);
}

export function snapshotValue(
  revision: number,
  page: PageV1,
  elements: readonly InkElementV1[],
): InkSnapshotV1 {
  return { elements: [...elements], format: "inkbook", page, revision, version: 1 };
}

export function envelope(
  revision: number,
  lockedHeight: number,
  metadata: Readonly<{ hash: string; text: string }>,
  background: string,
  highlights: string,
  content: string,
): string {
  return (
    `${rootPrefix(revision, lockedHeight, metadata.hash)}${metadata.text}</metadata>` +
    `<g id="inkbook-background">${background}</g>` +
    `<g id="inkbook-highlights">${highlights}</g>` +
    `<g id="inkbook-content">${content}</g></svg>`
  );
}

function rootPrefix(revision: number, lockedHeight: number, metadataHash: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2048.6 ${serializeSvgNumber(lockedHeight)}" ` +
    `data-inkbook-format="inkbook" data-inkbook-version="1" data-inkbook-revision="${revision}" ` +
    `data-inkbook-snapshot-sha256="${metadataHash}">` +
    `<style id="inkbook-theme">${CANONICAL_THEME_STYLESHEET}</style>` +
    `<metadata id="inkbook-snapshot" data-encoding="${COMPACT_METADATA_ENCODING}">`
  );
}
