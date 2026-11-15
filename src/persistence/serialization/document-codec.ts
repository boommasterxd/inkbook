import { derivePageExtent } from "../../domain/geometry/public";
import type { InkSnapshotV1, ValidationError } from "../../domain/schema/public";
import { FILE_SCHEMA_LIMITS, validateInkSnapshotV1 } from "../../domain/schema/public";
import { validateSafeSvg } from "../documents/safe-svg-validator";
import { serializeSvgEnvelope } from "../documents/svg-envelope";
import { serializeSvgNumber } from "../documents/svg-number";
import { backgroundFitsStaticLimit } from "./output/background";
import { boundedSvgBands } from "./output/bounded-svg-bands";
import { ChunkedOutputLimitError } from "./output/chunked-output-assembler";
import { UnpreparedAutoTextError } from "./output/auto-contrast-text-bounds";
import { SHA256_DOCUMENT_HASHER, type DocumentHashPort } from "./sha256";
import type {
  DocumentCodecError,
  DocumentCodecErrorCode,
  DocumentCodecResult,
  SerializedInkbookDocument,
} from "./types";
import { validateImageResourceSteps } from "../images/image-resources";
import { validateFontResourceSteps } from "../fonts/font-resources";
import { canonicalSnapshot } from "./metadata/canonical-snapshot";

const encoder = new TextEncoder();

export function serializeInkbookDocument(
  input: InkSnapshotV1,
  hasher: DocumentHashPort = SHA256_DOCUMENT_HASHER,
): DocumentCodecResult<SerializedInkbookDocument> {
  const validation = validateInkSnapshotV1(input);
  if (!validation.ok) {
    return failure("snapshot-invalid", "Snapshot validation failed.", validation.error);
  }
  try {
    for (const resource of [
      ...(validation.value.fontResources ?? []),
      ...(validation.value.imageResources ?? []),
    ]) {
      const steps = resource.mimeType.startsWith("image/")
        ? validateImageResourceSteps(
            resource as import("../../domain/schema/public").ImageResourceV3,
          )
        : validateFontResourceSteps(
            resource as import("../../domain/schema/public").FontResourceV2,
          );
      while (!steps.next().done) {
        /* Complete synchronous public codec. */
      }
    }
  } catch {
    return failure("snapshot-invalid", "Font resource content is invalid.");
  }
  let snapshot: InkSnapshotV1;
  try {
    snapshot = canonicalSnapshot(validation.value);
  } catch {
    return failure("snapshot-invalid", "A required text font resource is unavailable.");
  }
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
  let svg: string;
  try {
    svg = serializeSvgEnvelope(
      snapshot,
      lockedHeight,
      boundedSvgBands(snapshot, lockedHeight, validation.derivations),
    );
  } catch (error) {
    if (error instanceof UnpreparedAutoTextError) return failure("snapshot-invalid", error.message);
    if (!(error instanceof ChunkedOutputLimitError)) throw error;
    return failure("static-output-limit-exceeded", "Generated document exceeds file limits.");
  }
  const staticValidation = validateSafeSvg(svg);
  if (staticValidation === null || staticValidation.snapshotHash === null) {
    return failure(
      "static-output-limit-exceeded",
      "Generated SVG does not satisfy the static markup contract.",
    );
  }
  const metadataBytes = staticValidation.metadataBytes;
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
      snapshotHash: staticValidation.snapshotHash,
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
