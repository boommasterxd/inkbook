import { deriveRenderBands } from "../../domain/commands/render-bands";
import { derivePageExtent } from "../../domain/geometry/public";
import type { InkSnapshotV1, ValidationError } from "../../domain/schema/public";
import { FILE_SCHEMA_LIMITS, validateInkSnapshotV1 } from "../../domain/schema/public";
import { validateSafeSvg } from "../documents/safe-svg-validator";
import { serializeSvgEnvelope } from "../documents/svg-envelope";
import { serializeSvgNumber } from "../documents/svg-number";
import { backgroundFitsStaticLimit, serializeBackgroundPaths } from "./background";
import { canonicalSnapshot } from "./canonical-snapshot";
import { serializeElementPaths } from "./path-markup";
import { SHA256_DOCUMENT_HASHER, type DocumentHashPort } from "./sha256";
import type {
  DocumentCodecError,
  DocumentCodecErrorCode,
  DocumentCodecResult,
  SerializedInkbookDocument,
} from "./types";

const encoder = new TextEncoder();

export function serializeInkbookDocument(
  input: InkSnapshotV1,
  hasher: DocumentHashPort = SHA256_DOCUMENT_HASHER,
): DocumentCodecResult<SerializedInkbookDocument> {
  const validation = validateInkSnapshotV1(input);
  if (!validation.ok) {
    return failure("snapshot-invalid", "Snapshot validation failed.", validation.error);
  }
  const snapshot = canonicalSnapshot(validation.value);
  const extent = derivePageExtent(snapshot.page, validation.derivations.maximumBottom);
  const lockedHeight = canonicalSvgNumber(extent.lockedHeight);
  if (
    !backgroundFitsStaticLimit(
      snapshot.page.background,
      lockedHeight,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    )
  ) {
    return failure("static-output-limit-exceeded", "Generated background exceeds file limits.");
  }
  const bands = deriveRenderBands(snapshot.elements);
  const svg = serializeSvgEnvelope(snapshot, lockedHeight, {
    background: serializeBackgroundPaths(snapshot.page.background, lockedHeight),
    highlights: bands.highlight.flatMap(serializeElementPaths),
    content: bands.content.flatMap(serializeElementPaths),
  });
  const staticValidation = validateSafeSvg(svg);
  if (staticValidation === null) {
    return failure(
      "static-output-limit-exceeded",
      "Generated SVG does not satisfy the static markup contract.",
    );
  }
  const metadataBytes = encoder.encode(JSON.stringify(snapshot)).byteLength;
  const totalBytes = encoder.encode(svg).byteLength;
  if (
    metadataBytes > FILE_SCHEMA_LIMITS.metadataBytes ||
    totalBytes > FILE_SCHEMA_LIMITS.totalInputBytes
  ) {
    return failure("static-output-limit-exceeded", "Generated document exceeds file limits.");
  }
  return {
    ok: true,
    value: {
      hash: hasher.hash(svg),
      lockedHeight,
      metadataBytes,
      snapshot,
      svg,
      totalBytes,
    },
  };
}

function canonicalSvgNumber(value: number): number {
  return Number(serializeSvgNumber(value));
}

function failure<T>(
  code: Parameters<typeof codecError>[0],
  message: string,
  validationError?: Parameters<typeof codecError>[2],
): DocumentCodecResult<T> {
  return { ok: false, error: codecError(code, message, validationError) };
}

function codecError(
  code: DocumentCodecErrorCode,
  message: string,
  validationError?: ValidationError,
): DocumentCodecError {
  return validationError === undefined ? { code, message } : { code, message, validationError };
}
