import { deriveRenderBands } from "../../domain/commands/render-bands";
import { calculateElementBounds, derivePageExtent } from "../../domain/geometry/public";
import type { InkSnapshotV1, ValidationError } from "../../domain/schema/public";
import {
  FILE_SCHEMA_LIMITS,
  MAX_JSON_DEPTH,
  validateInkSnapshotV1,
} from "../../domain/schema/public";
import { jsonContainerBudget } from "../../domain/schema/validation-internals";
import { validateEditableSafeSvg, validateSafeSvg } from "../documents/safe-svg-validator";
import { serializeSvgEnvelope } from "../documents/svg-envelope";
import { serializeSvgNumber } from "../documents/svg-number";
import { backgroundFitsStaticLimit, serializeBackgroundPaths } from "./background";
import { validateCurrentMetadataIntegrity } from "./canonical-metadata";
import { canonicalSnapshot } from "./canonical-snapshot";
import { migrateAndValidateDocumentSnapshot } from "./document-migration";
import { assertJsonContainerWidths } from "./json-container-width";
import { serializeElementPaths } from "./path-markup";
import { SHA256_DOCUMENT_HASHER, type DocumentHashPort } from "./sha256";
import { verifyStaticPathIntegrity } from "./static-path-integrity";
import type {
  DocumentCodecError,
  DocumentCodecErrorCode,
  DocumentCodecResult,
  ParsedInkbookDocument,
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
  const extent = derivePageExtent(snapshot.page, maximumElementBottom(snapshot));
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

export function parseInkbookDocument(
  input: string | Uint8Array,
  hasher: DocumentHashPort = SHA256_DOCUMENT_HASHER,
): DocumentCodecResult<ParsedInkbookDocument> {
  const decoded = decodeInput(input);
  if (!decoded.ok) return decoded;
  const safe = validateEditableSafeSvg(decoded.value.svg);
  if (safe === null)
    return failure("invalid-svg", "Document does not satisfy the safe SVG envelope.");

  const migrated = parseAndValidateSnapshot(
    safe.metadataText,
    decoded.value.bytes,
    safe.metadataBytes,
  );
  if (!migrated.ok) return migrated;
  if (migrated.value.sourceVersion !== safe.version) {
    return failure("migration-failed", "Root and snapshot source versions do not match.");
  }
  const metadataIntegrity = validateCurrentMetadataIntegrity(
    safe.metadataText,
    safe.snapshotHash,
    migrated.value,
  );
  if (!metadataIntegrity.ok) return metadataIntegrity;
  const snapshot = migrated.value.snapshot;
  if (snapshot.revision !== safe.revision) {
    return failure("revision-mismatch", "Root and snapshot revisions do not match.");
  }
  const extent = derivePageExtent(snapshot.page, maximumElementBottom(snapshot));
  const lockedHeight = canonicalSvgNumber(extent.lockedHeight);
  if (lockedHeight !== safe.lockedHeight) {
    return failure(
      "locked-height-mismatch",
      "The SVG viewBox height is not the derived locked height.",
    );
  }
  if (!verifyStaticPathIntegrity(decoded.value.svg, safe, snapshot)) {
    return failure(
      "static-path-mismatch",
      "Static SVG paths do not match the canonical snapshot rendering.",
    );
  }
  return {
    ok: true,
    value: {
      hash: hasher.hash(decoded.value.hashInput),
      lockedHeight,
      snapshot,
      sourceVersion: migrated.value.sourceVersion,
    },
  };
}

function parseAndValidateSnapshot(
  metadataText: string,
  totalInputBytes: number,
  metadataBytes: number,
): DocumentCodecResult<import("./document-migration").MigratedSnapshot> {
  let parsed: unknown;
  try {
    assertJsonContainerWidths(metadataText, {
      maximumContainerEntries: jsonContainerBudget(FILE_SCHEMA_LIMITS),
      maximumDepth: MAX_JSON_DEPTH,
    });
    parsed = JSON.parse(metadataText);
  } catch {
    return failure("invalid-json", "Snapshot metadata is not valid JSON.");
  }
  return migrateAndValidateDocumentSnapshot(parsed, {
    metadataBytes,
    totalInputBytes,
  });
}

function canonicalSvgNumber(value: number): number {
  return Number(serializeSvgNumber(value));
}

function maximumElementBottom(snapshot: InkSnapshotV1): number | null {
  let maximum: number | null = null;
  for (const element of snapshot.elements) {
    maximum = Math.max(maximum ?? 0, calculateElementBounds(element).maxY);
  }
  return maximum;
}

function decodeInput(input: string | Uint8Array): DocumentCodecResult<{
  readonly bytes: number;
  readonly hashInput: string | Uint8Array;
  readonly svg: string;
}> {
  if (typeof input === "string") {
    const bytes = encoder.encode(input).byteLength;
    if (bytes > FILE_SCHEMA_LIMITS.totalInputBytes) {
      return failure("invalid-svg", "Document exceeds the 64 MiB input limit.");
    }
    return { ok: true, value: { bytes, hashInput: input, svg: input } };
  }
  if (input.byteLength > FILE_SCHEMA_LIMITS.totalInputBytes) {
    return failure("invalid-svg", "Document exceeds the 64 MiB input limit.");
  }
  try {
    return {
      ok: true,
      value: {
        bytes: input.byteLength,
        hashInput: input,
        svg: new TextDecoder("utf-8", { fatal: true }).decode(input),
      },
    };
  } catch {
    return failure("invalid-utf8", "Document bytes are not valid UTF-8.");
  }
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
