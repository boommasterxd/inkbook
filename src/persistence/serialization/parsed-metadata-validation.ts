import type { ParsedJsonProof } from "../../domain/schema/parsed-json-proof";
import type { SafeSvgPrelude } from "../documents/safe-svg-validator";
import { validateCurrentMetadataIntegrity } from "./canonical-metadata";
import { sha256TextChunked } from "./sha256";
import { decodeCompactSnapshotSteps } from "./compact-snapshot";
import { COMPACT_METADATA_ENCODING } from "./stroke-sample-codec";
import {
  migrateAndValidateDocumentSnapshotSteps,
  type MigratedSnapshot,
} from "./document-migration";
import type { DocumentCodecResult } from "./types";
import type { ChunkedInputCheckpoint } from "./chunked-input-types";
import type { StrokeSampleEncodingCache } from "./stroke-sample-encoding-cache";

interface MetadataValidationContext {
  readonly checkpoint: ChunkedInputCheckpoint;
  readonly metadataBytes: number;
  readonly metadataText: string;
  readonly prelude: SafeSvgPrelude | null;
  readonly signal?: AbortSignal;
  readonly sampleEncodingCache?: StrokeSampleEncodingCache;
  readonly staticValidation: "canonical" | "safe";
  readonly totalInputBytes: number;
}

/** Decode only parser-owned compact samples, then apply complete semantic model validation. */
export async function validateParsedMetadata(
  parsed: { readonly value: unknown; readonly proof: ParsedJsonProof },
  context: MetadataValidationContext,
): Promise<DocumentCodecResult<MigratedSnapshot>> {
  const actualMetadataHash =
    context.prelude?.version === 1
      ? await sha256TextChunked(context.metadataText, context.checkpoint, context.signal)
      : undefined;
  if (actualMetadataHash !== undefined && actualMetadataHash !== context.prelude?.snapshotHash) {
    return {
      ok: false,
      error: {
        code: "invalid-svg",
        message: "Snapshot metadata does not match its envelope hash.",
      },
    };
  }
  const compact = context.prelude?.metadataEncoding === COMPACT_METADATA_ENCODING;
  if (compact) {
    try {
      await runSteps(
        decodeCompactSnapshotSteps(parsed.value, context.signal, {
          proof: parsed.proof,
          ...(context.sampleEncodingCache === undefined
            ? {}
            : { sampleEncodingCache: context.sampleEncodingCache }),
        }),
        context.checkpoint,
      );
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return {
        ok: false,
        error: { code: "snapshot-invalid", message: "Invalid compact snapshot metadata." },
      };
    }
  }
  const migrated = await runSteps(
    migrateAndValidateDocumentSnapshotSteps(parsed.value, {
      allowRuntimeStrokeBuffers: compact,
      metadataBytes: context.metadataBytes,
      parsedJsonProof: parsed.proof,
      totalInputBytes: context.totalInputBytes,
    }),
    context.checkpoint,
  );
  if (!migrated.ok) return migrated;
  const integrity = validateCurrentMetadataIntegrity(
    context.metadataText,
    context.prelude?.snapshotHash ?? null,
    migrated.value,
    context.staticValidation,
    context.prelude?.metadataEncoding ?? "json",
    actualMetadataHash,
  );
  return integrity.ok ? migrated : integrity;
}

async function runSteps<T>(
  iterator: Generator<void, T>,
  checkpoint: ChunkedInputCheckpoint,
): Promise<T> {
  let step = iterator.next();
  while (!step.done) {
    const pending = checkpoint();
    if (pending !== undefined) await pending;
    step = iterator.next();
  }
  return step.value;
}
