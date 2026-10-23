import { metadataSha256 } from "../../../src/persistence/serialization/metadata/canonical-metadata";

export const CURRENT_METADATA_REWRITES = Object.freeze([
  Object.freeze({
    expectedCode: "invalid-json",
    mutate: (metadata: string) => `{ ${metadata.slice(1)}`,
    updateHash: true,
  }),
  Object.freeze({
    expectedCode: "invalid-svg",
    mutate: (metadata: string) =>
      metadata.replace('"activeBufferLines":3', '"activeBufferLines":4'),
    updateHash: false,
  }),
  Object.freeze({
    expectedCode: "invalid-json",
    mutate: (metadata: string) =>
      metadata.replace('{"format":"inkbook"', '{"format":"inkbook","format":"inkbook"'),
    updateHash: true,
  }),
]);

export function rewriteDocumentMetadata(
  svg: string,
  mutate: (metadata: string) => string,
  updateHash: boolean,
): string {
  const openingTag = svg.indexOf("<metadata");
  const start = svg.indexOf(">", openingTag) + 1;
  const end = svg.indexOf("</metadata>", start);
  if (openingTag < 0 || start === 0 || end < start) {
    throw new Error("Expected a complete Inkbook metadata element.");
  }
  const metadata = mutate(svg.slice(start, end));
  const rewritten = `${svg.slice(0, start)}${metadata}${svg.slice(end)}`;
  return updateHash
    ? rewritten.replace(
        /data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u,
        `data-inkbook-snapshot-sha256="${metadataSha256(metadata)}"`,
      )
    : rewritten;
}
