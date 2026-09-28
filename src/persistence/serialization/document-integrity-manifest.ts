import type { InkSnapshotV1 } from "../../domain/schema/public";

import { canonicalMetadataSha256 } from "./canonical-metadata";
import { ChunkedSha256 } from "./chunked-output-sha256";

const encoder = new TextEncoder();
const SHA256_HEX = /^[a-f\d]{64}$/u;
const ORDER_DIGEST_CHUNK_CHARACTERS = 64 * 1024;

export interface DocumentIntegrityManifest {
  readonly contentDigest: string;
  readonly elementCount: number;
  readonly orderedIdDigest: string;
  readonly revision: number;
}

export function deriveDocumentIntegrityManifest(
  snapshot: InkSnapshotV1,
): DocumentIntegrityManifest {
  return manifest(snapshot, canonicalMetadataSha256(snapshot));
}

export function deriveDocumentIntegrityManifestFromContentDigest(
  snapshot: InkSnapshotV1,
  contentDigest: string,
): DocumentIntegrityManifest {
  assertDigest(contentDigest);
  return manifest(snapshot, contentDigest);
}

export function sameDocumentIntegrityManifest(
  left: DocumentIntegrityManifest | undefined,
  right: DocumentIntegrityManifest | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.revision === right.revision &&
    left.elementCount === right.elementCount &&
    left.orderedIdDigest === right.orderedIdDigest &&
    left.contentDigest === right.contentDigest
  );
}

export function isDocumentIntegrityManifest(value: unknown): value is DocumentIntegrityManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DocumentIntegrityManifest>;
  return (
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision! >= 0 &&
    Number.isSafeInteger(candidate.elementCount) &&
    candidate.elementCount! >= 0 &&
    typeof candidate.orderedIdDigest === "string" &&
    SHA256_HEX.test(candidate.orderedIdDigest) &&
    typeof candidate.contentDigest === "string" &&
    SHA256_HEX.test(candidate.contentDigest)
  );
}

function manifest(snapshot: InkSnapshotV1, contentDigest: string): DocumentIntegrityManifest {
  return Object.freeze({
    contentDigest,
    elementCount: snapshot.elements.length,
    orderedIdDigest: orderedIdDigest(snapshot),
    revision: snapshot.revision,
  });
}

function orderedIdDigest(snapshot: InkSnapshotV1): string {
  const hasher = new ChunkedSha256();
  let chunk = "inkbook-ordered-ids-v1";
  for (const element of snapshot.elements) {
    chunk += `\0${element.id}`;
    if (chunk.length < ORDER_DIGEST_CHUNK_CHARACTERS) continue;
    hasher.update(encoder.encode(chunk));
    chunk = "";
  }
  hasher.update(encoder.encode(chunk));
  return hasher.digestHex();
}

function assertDigest(value: string): void {
  if (!SHA256_HEX.test(value)) throw new TypeError("Content digest must be a SHA-256 hex value.");
}
