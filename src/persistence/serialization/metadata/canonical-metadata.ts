import type { InkSnapshotV1, PageV1 } from "../../../domain/schema/public";

import { canonicalElement, canonicalPage } from "./canonical-snapshot";
import { serializeCanonicalElementMetadata } from "./canonical-element-fragments";
import { COMPACT_METADATA_ENCODING, type SnapshotMetadataEncoding } from "./stroke-sample-codec";
import {
  hashExactUtf8Output,
  type ChunkedOutputAssemblyOptions,
  type ExactOutputDigest,
} from "../output/chunked-output-assembler";
import { ChunkedSha256 } from "../chunked-output-sha256";
import type { MigratedSnapshot } from "./document-migration";
import type { DocumentCodecResult } from "../types";

const encoder = new TextEncoder();
const HASH_INPUT_CHARACTERS = 64 * 1024;
const COMMA_BYTES = encoder.encode(",");
const METADATA_SUFFIX_BYTES = encoder.encode("]}");

export interface CanonicalMetadataHashOptions extends ChunkedOutputAssemblyOptions {
  readonly digest?: ExactOutputDigest | null;
}

export function canonicalMetadataText(snapshot: InkSnapshotV1): string {
  return [...canonicalMetadataFragments(snapshot)].join("");
}

export function canonicalMetadataSha256(snapshot: InkSnapshotV1): string {
  return hashFragments(canonicalMetadataFragments(snapshot));
}

export function canonicalMetadataFragmentsSha256(
  prefix: string,
  elements: Iterable<string>,
): string {
  return hashFragments(completeMetadataTextFragments(prefix, elements));
}

export async function canonicalMetadataSha256Async(
  prefix: string,
  elementMetadata: Iterable<Uint8Array>,
  totalBytes: number,
  options: CanonicalMetadataHashOptions = {},
): Promise<string> {
  const sliceByteLimit = options.sliceByteLimit ?? HASH_INPUT_CHARACTERS;
  if (!Number.isSafeInteger(sliceByteLimit) || sliceByteLimit <= 0) {
    throw new RangeError("Metadata hash slice byte limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new RangeError("Metadata hash byte length must be a non-negative safe integer.");
  }
  const output = new Uint8Array(totalBytes);
  const writer = new CanonicalMetadataWriter(output, sliceByteLimit);
  let bytesSinceCheckpoint = 0;
  for (const fragment of completeMetadataByteFragments(prefix, elementMetadata)) {
    options.signal?.throwIfAborted();
    for (const written of writer.append(fragment)) {
      bytesSinceCheckpoint += written;
      if (options.checkpoint !== undefined && bytesSinceCheckpoint >= sliceByteLimit) {
        const pending = options.checkpoint();
        if (pending !== undefined) await pending;
        options.signal?.throwIfAborted();
        bytesSinceCheckpoint = 0;
      }
    }
  }
  writer.finish();
  return hashExactUtf8Output(output, options.signal, options.digest, options.checkpoint);
}

function canonicalMetadataMatches(
  input: string,
  snapshot: InkSnapshotV1,
  encoding: SnapshotMetadataEncoding,
): boolean {
  let offset = 0;
  for (const fragment of canonicalMetadataFragments(snapshot, encoding)) {
    if (!input.startsWith(fragment, offset)) return false;
    offset += fragment.length;
  }
  return offset === input.length;
}

export function validateCurrentMetadataIntegrity(
  metadataText: string,
  expectedHash: string | null,
  migrated: MigratedSnapshot,
  validation: "canonical" | "safe" = "canonical",
  encoding: SnapshotMetadataEncoding = COMPACT_METADATA_ENCODING,
  actualMetadataHash?: string,
): DocumentCodecResult<undefined> {
  if (migrated.sourceVersion !== 1) return { ok: true, value: undefined };
  if (
    validation === "canonical" &&
    !canonicalMetadataMatches(metadataText, migrated.snapshot, encoding)
  ) {
    return metadataFailure("invalid-json", "Snapshot metadata is not canonical compact JSON.");
  }
  if (
    expectedHash === null ||
    (actualMetadataHash ?? metadataSha256(metadataText)) !== expectedHash
  ) {
    return metadataFailure("invalid-svg", "Snapshot metadata does not match its envelope hash.");
  }
  return { ok: true, value: undefined };
}

export function metadataSha256(input: string): string {
  const hash = new ChunkedSha256();
  let offset = 0;
  while (offset < input.length) {
    let end = Math.min(offset + HASH_INPUT_CHARACTERS, input.length);
    if (end < input.length && isHighSurrogate(input.charCodeAt(end - 1))) end -= 1;
    hash.update(encoder.encode(input.slice(offset, end)));
    offset = end;
  }
  return hash.digestHex();
}

function hashFragments(fragments: Iterable<string>): string {
  const hash = new ChunkedSha256();
  for (const fragment of fragments) updateHash(hash, fragment);
  return hash.digestHex();
}

export function metadataPrefix(revision: number, page: PageV1): string {
  return (
    `{"format":"inkbook","version":1,"revision":${revision},` +
    `"page":${JSON.stringify(canonicalPage(page))},"elements":[`
  );
}

function* canonicalMetadataFragments(
  snapshot: InkSnapshotV1,
  encoding: SnapshotMetadataEncoding = COMPACT_METADATA_ENCODING,
): Iterable<string> {
  yield metadataPrefix(snapshot.revision, snapshot.page);
  for (let index = 0; index < snapshot.elements.length; index += 1) {
    if (index > 0) yield ",";
    const element = snapshot.elements[index]!;
    yield encoding === "json"
      ? JSON.stringify(canonicalElement(element))
      : serializeCanonicalElementMetadata(element);
  }
  yield "]}";
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function updateHash(hash: ChunkedSha256, input: string): void {
  hash.update(encoder.encode(input));
}

class CanonicalMetadataWriter {
  readonly #output: Uint8Array<ArrayBuffer>;
  readonly #sliceByteLimit: number;
  #offset = 0;

  public constructor(output: Uint8Array<ArrayBuffer>, sliceByteLimit: number) {
    this.#output = output;
    this.#sliceByteLimit = sliceByteLimit;
  }

  public *append(input: Uint8Array): Iterable<number> {
    for (let offset = 0; offset < input.byteLength;) {
      const end = Math.min(input.byteLength, offset + this.#sliceByteLimit);
      this.#output.set(input.subarray(offset, end), this.#offset);
      const written = end - offset;
      this.#offset += written;
      offset = end;
      yield written;
    }
  }

  public finish(): void {
    if (this.#offset !== this.#output.byteLength) {
      throw new RangeError("Metadata hash byte count is inconsistent.");
    }
  }
}

function* completeMetadataByteFragments(
  prefix: string,
  elements: Iterable<Uint8Array>,
): Iterable<Uint8Array> {
  yield encoder.encode(prefix);
  let first = true;
  for (const element of elements) {
    if (!first) yield COMMA_BYTES;
    yield element;
    first = false;
  }
  yield METADATA_SUFFIX_BYTES;
}

function* completeMetadataTextFragments(
  prefix: string,
  elements: Iterable<string>,
): Iterable<string> {
  yield prefix;
  let first = true;
  for (const element of elements) {
    if (!first) yield ",";
    yield element;
    first = false;
  }
  yield "]}";
}

function metadataFailure(
  code: "invalid-json" | "invalid-svg",
  message: string,
): DocumentCodecResult<never> {
  return { error: { code, message }, ok: false };
}
