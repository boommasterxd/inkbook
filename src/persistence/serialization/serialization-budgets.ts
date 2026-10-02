import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { PageV1 } from "../../domain/schema/public";
import { documentStaticByteLength } from "./document-assembly";
import { EncodedByteBudget, encodedByteLength } from "./encoded-byte-budget";
import { snapshotMetadataPrefix } from "./document-assembly";
import { codecFailure } from "./codec-failure";
import { derivePageExtent } from "../../domain/geometry/public";
import { serializeSvgNumber } from "../documents/svg-number";
import type { BackgroundFragmentCache } from "./background";
import type {
  Background,
  PreparedSerialization,
  SerializationBudgets,
} from "./incremental-document-serializer-types";
import type { DocumentCodecResult } from "./types";

function createSerializationBudgets(
  revision: number,
  lockedHeight: number,
  metadataPrefix: string,
  background: string,
): SerializationBudgets {
  return {
    metadata: new EncodedByteBudget(
      FILE_SCHEMA_LIMITS.metadataBytes,
      encodedByteLength(metadataPrefix),
    ),
    output: new EncodedByteBudget(
      FILE_SCHEMA_LIMITS.totalInputBytes,
      documentStaticByteLength(revision, lockedHeight, metadataPrefix, background),
    ),
  };
}

export function prepareSerialization(
  page: PageV1 | null,
  revision: number | null,
  maximumBottom: number | null,
  backgroundCache: BackgroundFragmentCache,
): DocumentCodecResult<PreparedSerialization> {
  if (page === null || revision === null) {
    return codecFailure("invalid-delta", "Serializer has no initialized document model.");
  }
  const resolvedBackground = resolveBackground(page, maximumBottom, backgroundCache);
  if (!resolvedBackground.ok) return resolvedBackground;
  const { background, lockedHeight } = resolvedBackground.value;
  const metadataPrefix = snapshotMetadataPrefix(revision, page);
  const { output, metadata } = createSerializationBudgets(
    revision,
    lockedHeight,
    metadataPrefix,
    background,
  );
  return {
    ok: true,
    value: { background, lockedHeight, metadataPrefix, metadata, output, page, revision },
  };
}

function resolveBackground(
  page: PageV1,
  maximumBottom: number | null,
  cache: BackgroundFragmentCache,
): DocumentCodecResult<Background> {
  const extent = derivePageExtent(page, maximumBottom);
  const lockedHeight = Number(serializeSvgNumber(extent.lockedHeight));
  const background = cache.resolve(page, lockedHeight, FILE_SCHEMA_LIMITS.totalInputBytes);
  if (background === null) {
    return codecFailure(
      "static-output-limit-exceeded",
      "Generated background exceeds file limits.",
    );
  }
  return { ok: true, value: { background, lockedHeight } };
}
