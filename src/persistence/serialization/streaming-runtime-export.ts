import { derivePageExtent } from "../../domain/geometry/public";
import { FILE_SCHEMA_LIMITS, type InkSnapshotV1 } from "../../domain/schema/public";
import { serializeSvgNumber } from "../documents/svg-number";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "../documents/svg-output-limits";
import { BackgroundFragmentCache, backgroundPathDataByteLength } from "./background";
import {
  assembleAndHashPreparedUtf8Output,
  type ChunkedOutputAssemblyOptions,
} from "./chunked-output-assembler";
import { codecFailure } from "./codec-failure";
import {
  canonicalMetadataSha256Async,
  metadataPrefix as canonicalMetadataPrefix,
} from "./canonical-metadata";
import {
  documentUtf8Fragments,
  documentStaticByteLength,
  snapshotMetadataPrefix,
} from "./document-assembly";
import { EncodedByteBudget, encodedByteLength } from "./encoded-byte-budget";
import { elementRenderBand, type ElementFragments } from "./element-fragments";
import type { DocumentCodecResult, SerializedInkbookDocument } from "./types";

interface PreparedRuntimeExport {
  readonly background: string;
  readonly fragments: readonly ElementFragments[];
  readonly lockedHeight: number;
  readonly metadataBytes: number;
  readonly metadataHash: string;
  readonly metadataPrefix: string;
  readonly totalBytes: number;
}

export type RuntimeElementFragmentResolver = (
  element: InkSnapshotV1["elements"][number],
) => ElementFragments | Promise<ElementFragments>;

export async function serializeRuntimeSnapshotToUtf8(
  snapshot: InkSnapshotV1,
  options: ChunkedOutputAssemblyOptions,
  resolveFragment: RuntimeElementFragmentResolver,
  backgroundCache = new BackgroundFragmentCache(),
): Promise<DocumentCodecResult<SerializedInkbookDocument<Uint8Array<ArrayBuffer>>>> {
  const prepared = await prepareRuntimeExport(snapshot, options, resolveFragment, backgroundCache);
  if (!prepared.ok) return prepared;
  const value = prepared.value;
  const assembled = await assembleAndHashPreparedUtf8Output(
    runtimeDocumentFragments(snapshot, value),
    value.totalBytes,
    { ...options, maximumBytes: FILE_SCHEMA_LIMITS.totalInputBytes },
  );
  return {
    ok: true,
    value: {
      hash: assembled.hash,
      lockedHeight: value.lockedHeight,
      metadataBytes: value.metadataBytes,
      snapshot,
      snapshotHash: value.metadataHash,
      svg: assembled.output,
      totalBytes: assembled.totalBytes,
    },
  };
}

async function prepareRuntimeExport(
  snapshot: InkSnapshotV1,
  options: ChunkedOutputAssemblyOptions,
  resolveFragment: RuntimeElementFragmentResolver,
  backgroundCache: BackgroundFragmentCache,
): Promise<DocumentCodecResult<PreparedRuntimeExport>> {
  const metadataPrefix = snapshotMetadataPrefix(snapshot.revision, snapshot.page);
  const canonicalPrefix = canonicalMetadataPrefix(snapshot.revision, snapshot.page);
  const metadataPrefixBytes = encodedByteLength(metadataPrefix);
  let canonicalMetadataBytes = encodedByteLength(canonicalPrefix) + 2;
  const metadataBudget = new EncodedByteBudget(
    FILE_SCHEMA_LIMITS.metadataBytes,
    metadataPrefixBytes,
  );
  const outputBudget = new EncodedByteBudget(
    FILE_SCHEMA_LIMITS.totalInputBytes,
    metadataPrefixBytes,
  );
  let maximumBottom: number | null = null;
  const fragments: ElementFragments[] = [];
  const pathDataBudget = new EncodedByteBudget(MAXIMUM_TOTAL_PATH_DATA_BYTES);
  for (let index = 0; index < snapshot.elements.length; index += 1) {
    options.signal?.throwIfAborted();
    const element = snapshot.elements[index]!;
    const resolved = resolveFragment(element);
    const fragment = resolved instanceof Promise ? await resolved : resolved;
    fragments.push(fragment);
    const separatorBytes = index === 0 ? 0 : 1;
    canonicalMetadataBytes += fragment.canonicalMetadataBytes + separatorBytes;
    if (
      !metadataBudget.tryReserve(fragment.metadataBytes + separatorBytes) ||
      !outputBudget.tryReserve(fragment.bytes + separatorBytes) ||
      !pathDataBudget.tryReserve(fragment.pathDataBytes)
    ) {
      return limitFailure();
    }
    maximumBottom = Math.max(maximumBottom ?? 0, fragment.bottom);
    const pending = options.checkpoint?.();
    if (pending !== undefined) await pending;
  }
  if (!metadataBudget.tryReserve(2)) return limitFailure();
  const extent = derivePageExtent(snapshot.page, maximumBottom);
  const lockedHeight = Number(serializeSvgNumber(extent.lockedHeight));
  if (
    !pathDataBudget.tryReserve(backgroundPathDataByteLength(snapshot.page.background, lockedHeight))
  ) {
    return limitFailure();
  }
  const background = backgroundCache.resolve(
    snapshot.page,
    lockedHeight,
    FILE_SCHEMA_LIMITS.totalInputBytes,
  );
  if (background === null) return limitFailure();
  const metadataHash = await canonicalMetadataSha256Async(
    canonicalPrefix,
    fragmentCanonicalMetadata(fragments),
    canonicalMetadataBytes,
    options,
  );
  const remainingStaticBytes =
    documentStaticByteLength(snapshot.revision, lockedHeight, metadataPrefix, background) -
    metadataPrefixBytes;
  if (!outputBudget.tryReserve(remainingStaticBytes)) {
    return limitFailure();
  }
  return {
    ok: true,
    value: {
      background,
      fragments,
      lockedHeight,
      metadataBytes: metadataBudget.usedBytes,
      metadataHash,
      metadataPrefix,
      totalBytes: outputBudget.usedBytes,
    },
  };
}

function* fragmentCanonicalMetadata(fragments: readonly ElementFragments[]): Iterable<Uint8Array> {
  for (const fragment of fragments) yield fragment.canonicalMetadataUtf8;
}

function runtimeDocumentFragments(
  snapshot: InkSnapshotV1,
  prepared: PreparedRuntimeExport,
): Iterable<Uint8Array> {
  return documentUtf8Fragments(
    snapshot.revision,
    prepared.lockedHeight,
    prepared.metadataPrefix,
    prepared.metadataHash,
    {
      content: fragmentMarkup(prepared.fragments, "content"),
      highlight: fragmentMarkup(prepared.fragments, "highlight"),
      metadata: fragmentMetadata(prepared.fragments),
    },
    prepared.background,
  );
}

function* fragmentMetadata(fragments: readonly ElementFragments[]): Iterable<Uint8Array> {
  for (const fragment of fragments) yield fragment.metadataUtf8;
}

function* fragmentMarkup(
  fragments: readonly ElementFragments[],
  band: "content" | "highlight",
): Iterable<Uint8Array> {
  for (const fragment of fragments) {
    if (elementRenderBand(fragment.element) !== band) continue;
    yield fragment.svgUtf8;
  }
}

function limitFailure(): DocumentCodecResult<never> {
  return codecFailure("static-output-limit-exceeded", "Generated document exceeds file limits.");
}
