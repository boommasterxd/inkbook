import { derivePageExtent } from "../../../domain/geometry/public";
import {
  FILE_SCHEMA_LIMITS,
  type ImageElementV3,
  type InkSnapshotV1,
} from "../../../domain/schema/public";
import { serializeSvgNumber } from "../../documents/svg-number";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "../../documents/svg-output-limits";
import { BackgroundFragmentCache, backgroundPathDataByteLength } from "./background";
import {
  assembleAndHashPreparedUtf8Output,
  type ChunkedOutputAssemblyOptions,
} from "./chunked-output-assembler";
import { codecFailure } from "../codec-failure";
import {
  canonicalMetadataSha256Async,
  metadataPrefix as canonicalMetadataPrefix,
} from "../metadata/canonical-metadata";
import {
  documentUtf8Fragments,
  documentStaticByteLength,
  snapshotMetadataPrefix,
} from "./document-assembly";
import { EncodedByteBudget, encodedByteLength } from "./encoded-byte-budget";
import { elementRenderBand, type ElementFragments } from "./element-fragments";
import type { DocumentCodecResult, SerializedInkbookDocument } from "../types";
import { snapshotImageResources } from "./image-markup";
import { snapshotTextResources } from "./text-fonts";
import { autoExportFragmentSteps } from "./auto-contrast-export";
import { consumeSerializationSteps } from "./serialization-model-preparation";
import { UnpreparedAutoTextError } from "./auto-contrast-text-bounds";
import { ChunkedOutputLimitError } from "./chunked-output-assembler";
import { AutoPaintServerRegistry } from "./auto-contrast-servers";

interface PreparedRuntimeExport {
  readonly autoPaints: AutoPaintServerRegistry;
  readonly underlayImages: readonly ImageElementV3[];
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
  // Keep current record identities for the fragment cache while pruning font resources.
  const { fontResources: _resources, imageResources: _images, ...header } = snapshot;
  snapshot = {
    ...header,
    ...snapshotTextResources(snapshot),
    ...snapshotImageResources(snapshot, true),
  };
  let prepared: Awaited<ReturnType<typeof prepareRuntimeExport>>;
  try {
    prepared = await prepareRuntimeExport(snapshot, options, resolveFragment, backgroundCache);
  } catch (error) {
    if (error instanceof UnpreparedAutoTextError)
      return codecFailure("snapshot-invalid", error.message);
    if (error instanceof ChunkedOutputLimitError) return limitFailure();
    throw error;
  }
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
  const metadataPrefix = snapshotMetadataPrefix(snapshot.revision, snapshot.page, snapshot);
  const canonicalPrefix = canonicalMetadataPrefix(snapshot.revision, snapshot.page, snapshot);
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
  const autoPaints = new AutoPaintServerRegistry();
  let serverBytes = 0;
  const underlayImages: ImageElementV3[] = [];
  const pathDataBudget = new EncodedByteBudget(MAXIMUM_TOTAL_PATH_DATA_BYTES);
  for (let index = 0; index < snapshot.elements.length; index += 1) {
    options.signal?.throwIfAborted();
    const element = snapshot.elements[index]!;
    if (element.kind === "image") underlayImages.push(element);
    const resolved = resolveFragment(element);
    const cached = resolved instanceof Promise ? await resolved : resolved;
    const fragment =
      snapshot.version < 5 || (snapshot.imageResources?.length ?? 0) === 0
        ? cached
        : await consumeSerializationSteps(
            autoExportFragmentSteps(cached, options.signal, autoPaints),
            options,
          );
    fragments.push(fragment);
    const separatorBytes = index === 0 ? 0 : 1;
    const currentServerBytes = autoPaints.contentByteLength;
    canonicalMetadataBytes += fragment.canonicalMetadataBytes + separatorBytes;
    if (
      !metadataBudget.tryReserve(fragment.metadataBytes + separatorBytes) ||
      !outputBudget.tryReserve(
        fragment.bytes + separatorBytes + currentServerBytes - serverBytes,
      ) ||
      !pathDataBudget.tryReserve(fragment.pathDataBytes)
    ) {
      return limitFailure();
    }
    serverBytes = currentServerBytes;
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
    documentStaticByteLength(
      snapshot.revision,
      lockedHeight,
      metadataPrefix,
      background,
      snapshot,
      underlayImages,
    ) - metadataPrefixBytes;
  if (!outputBudget.tryReserve(remainingStaticBytes)) return limitFailure();
  return {
    ok: true,
    value: {
      background,
      autoPaints,
      underlayImages,
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
      snapshot,
      autoPaints: prepared.autoPaints,
      underlayImages: prepared.underlayImages,
      image: fragmentMarkup(prepared.fragments, "image"),
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
  band: "image" | "content" | "highlight",
): Iterable<Uint8Array> {
  for (const fragment of fragments) {
    if (elementRenderBand(fragment.element) !== band) continue;
    if (fragment.presentation === undefined) yield fragment.svgUtf8;
    else yield* fragment.presentation.chunks;
  }
}

function limitFailure(): DocumentCodecResult<never> {
  return codecFailure("static-output-limit-exceeded", "Generated document exceeds file limits.");
}
