import type { InkSnapshotV1 } from "../../domain/schema/public";

import { canonicalMetadataSha256, metadataPrefix } from "./canonical-metadata";
import { canonicalElement } from "./canonical-snapshot";
import { ChunkedSha256 } from "./chunked-output-sha256";

const encoder = new TextEncoder();
const SHA256_HEX = /^[a-f\d]{64}$/u;
const DEFAULT_SLICE_BYTES = 64 * 1024;
const ORDER_DIGEST_CHUNK_CHARACTERS = 64 * 1024;

export interface DocumentIntegrityManifest {
  readonly contentDigest: string;
  readonly elementCount: number;
  readonly orderedIdDigest: string;
  readonly revision: number;
}

export interface DocumentIntegrityManifestDerivationOptions {
  readonly checkpoint?: () => Promise<void>;
  readonly signal?: AbortSignal;
  readonly sliceByteLimit?: number;
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

export async function deriveDocumentIntegrityManifestAsync(
  snapshot: InkSnapshotV1,
  options: DocumentIntegrityManifestDerivationOptions = {},
): Promise<DocumentIntegrityManifest> {
  const sliceByteLimit = options.sliceByteLimit ?? DEFAULT_SLICE_BYTES;
  if (!Number.isSafeInteger(sliceByteLimit) || sliceByteLimit < 1) {
    throw new RangeError("Manifest slice byte limit must be a positive safe integer.");
  }
  const contentHasher = new ChunkedSha256();
  await updateCanonicalMetadata(contentHasher, snapshot, options, sliceByteLimit);
  return manifest(snapshot, contentHasher.digestHex());
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

async function updateCanonicalMetadata(
  hasher: ChunkedSha256,
  snapshot: InkSnapshotV1,
  options: DocumentIntegrityManifestDerivationOptions,
  sliceByteLimit: number,
): Promise<void> {
  const checkpoint = new ManifestCheckpoint(hasher, options, sliceByteLimit);
  await checkpoint.update(metadataPrefix(snapshot.revision, snapshot.page));
  for (let index = 0; index < snapshot.elements.length; index += 1) {
    if (index > 0) await checkpoint.update(",");
    await checkpoint.update(JSON.stringify(canonicalElement(snapshot.elements[index]!)));
  }
  await checkpoint.update("]}");
}

class ManifestCheckpoint {
  #bytesSinceCheckpoint = 0;
  readonly #charactersPerChunk: number;

  public constructor(
    readonly hasher: ChunkedSha256,
    readonly options: DocumentIntegrityManifestDerivationOptions,
    readonly sliceByteLimit: number,
  ) {
    this.#charactersPerChunk = Math.max(1, Math.floor(sliceByteLimit / 4));
  }

  public async update(value: string): Promise<void> {
    for (let offset = 0; offset < value.length;) {
      this.options.signal?.throwIfAborted();
      const end = nextChunkEnd(value, offset, this.#charactersPerChunk);
      const bytes = encoder.encode(value.slice(offset, end));
      this.hasher.update(bytes);
      this.#bytesSinceCheckpoint += bytes.byteLength;
      offset = end;
      if (this.options.checkpoint && this.#bytesSinceCheckpoint >= this.sliceByteLimit) {
        await this.options.checkpoint();
        this.#bytesSinceCheckpoint = 0;
      }
    }
  }
}

function nextChunkEnd(value: string, offset: number, chunkCharacters: number): number {
  let end = Math.min(value.length, offset + chunkCharacters);
  const trailing = value.charCodeAt(end - 1);
  if (end < value.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
  return end;
}

function assertDigest(value: string): void {
  if (!SHA256_HEX.test(value)) throw new TypeError("Content digest must be a SHA-256 hex value.");
}
