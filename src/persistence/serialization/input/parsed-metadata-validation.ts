import type { ParsedJsonProof } from "../../../domain/schema/parsed-json-proof";
import type { SafeSvgPrelude } from "../../documents/safe-svg-validator";
import { validateCurrentMetadataIntegrity } from "../metadata/canonical-metadata";
import { sha256TextChunked } from "../sha256";
import { decodeCompactSnapshotSteps } from "../metadata/compact-snapshot";
import { COMPACT_METADATA_ENCODING } from "../metadata/stroke-sample-codec";
import {
  migrateAndValidateDocumentSnapshotSteps,
  type MigratedSnapshot,
} from "../metadata/document-migration";
import type { DocumentCodecResult } from "../types";
import type { ChunkedInputCheckpoint } from "./chunked-input-types";
import type { StrokeSampleEncodingCache } from "../metadata/stroke-sample-encoding-cache";
import { validateFontResourceSteps } from "../../fonts/font-resources";
import { restoreCompactFontResourcesSteps } from "../metadata/compact-font-resources";
import { usedFontResourcesSteps } from "../../fonts/used-font-resources";
import { validateImageResourceSteps } from "../../images/image-resources";
import { restoreCompactImageResourcesSteps } from "../metadata/compact-image-resources";

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
    context.prelude !== null && context.prelude.version >= 1
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
  const restored = await restoreParsedResources(parsed.value, context);
  if (!restored.ok) return restored;
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
      ...(restored.value ? {} : { parsedJsonProof: parsed.proof }),
      totalInputBytes: context.totalInputBytes,
    }),
    context.checkpoint,
  );
  if (!migrated.ok) return migrated;
  const resources = await validateParsedResources(migrated.value, context);
  if (!resources.ok) return resources;
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

async function restoreParsedFonts(
  value: unknown,
  context: MetadataValidationContext,
): Promise<DocumentCodecResult<boolean>> {
  try {
    return {
      ok: true,
      value: await runSteps(
        restoreCompactFontResourcesSteps(value, context.prelude),
        context.checkpoint,
      ),
    };
  } catch (error) {
    context.signal?.throwIfAborted();
    if (!(error instanceof RangeError)) throw error;
    return {
      ok: false,
      error: { code: "snapshot-invalid", message: "Embedded font descriptors are invalid." },
    };
  }
}

async function validateParsedFonts(
  migrated: MigratedSnapshot,
  context: MetadataValidationContext,
): Promise<DocumentCodecResult<undefined>> {
  try {
    for (const resource of migrated.snapshot.fontResources ?? []) {
      await runSteps(validateFontResourceSteps(resource, context.signal), context.checkpoint);
    }
    await runSteps(
      usedFontResourcesSteps(migrated.snapshot.elements, migrated.snapshot.fontResources ?? []),
      context.checkpoint,
    );
  } catch (error) {
    context.signal?.throwIfAborted();
    if (!(error instanceof RangeError)) throw error;
    return {
      ok: false,
      error: { code: "snapshot-invalid", message: "Font resource content is invalid." },
    };
  }
  return { ok: true, value: undefined };
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

async function restoreParsedImages(
  value: unknown,
  context: MetadataValidationContext,
): Promise<DocumentCodecResult<boolean>> {
  try {
    return {
      ok: true,
      value: await runSteps(
        restoreCompactImageResourcesSteps(value, context.prelude),
        context.checkpoint,
      ),
    };
  } catch {
    context.signal?.throwIfAborted();
    return {
      ok: false,
      error: { code: "snapshot-invalid", message: "Embedded image descriptors are invalid." },
    };
  }
}
async function validateParsedImages(
  snapshot: MigratedSnapshot["snapshot"],
  context: MetadataValidationContext,
): Promise<DocumentCodecResult<void>> {
  try {
    for (const image of snapshot.imageResources ?? [])
      await runSteps(validateImageResourceSteps(image, context.signal), context.checkpoint);
    return { ok: true, value: undefined };
  } catch {
    context.signal?.throwIfAborted();
    return {
      ok: false,
      error: { code: "snapshot-invalid", message: "Image resource content is invalid." },
    };
  }
}

async function restoreParsedResources(
  value: unknown,
  context: MetadataValidationContext,
): Promise<DocumentCodecResult<boolean>> {
  const fonts = await restoreParsedFonts(value, context);
  if (!fonts.ok) return fonts;
  const images = await restoreParsedImages(value, context);
  return images.ok ? { ok: true, value: fonts.value || images.value } : images;
}
async function validateParsedResources(
  migrated: MigratedSnapshot,
  context: MetadataValidationContext,
): Promise<DocumentCodecResult<void>> {
  const fonts = await validateParsedFonts(migrated, context);
  return fonts.ok ? validateParsedImages(migrated.snapshot, context) : fonts;
}
