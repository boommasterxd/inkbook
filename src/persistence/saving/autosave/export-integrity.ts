import type { InkElementV1, InkSnapshotV1 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { ExportSuccess } from "../../worker/protocol";
import {
  deriveDocumentIntegrityManifestFromContentDigest,
  sameDocumentIntegrityManifest,
  type DocumentIntegrityManifest,
} from "../../serialization/public";
import { CanonicalMetadataCache } from "../../serialization/canonical-metadata-cache";
import { createMainThreadCheckpoint } from "../../scheduling/main-thread-checkpoint";
import { adoptOwnedSvgOutput } from "../../scheduling/owned-svg-output";

import type { AutosaveCoordinatorOptions } from "./types";

export type ExportIntegrityDecision = "cancelled" | "fail" | "match" | "retry-full";

export class AutosaveExportIntegrity {
  #retryUsed = false;
  readonly #metadata: CanonicalMetadataCache;

  public clear(): void {
    this.#metadata.clear();
  }

  public constructor(
    readonly waitForBackground?: () => Promise<void>,
    ownsElement?: (element: InkElementV1) => boolean,
    readonly workScheduler?: WorkScheduler,
  ) {
    this.#metadata = new CanonicalMetadataCache(ownsElement);
  }

  public async verify(
    snapshot: () => InkSnapshotV1,
    workerManifest: DocumentIntegrityManifest,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
  ): Promise<ExportIntegrityDecision> {
    let matches = false;
    try {
      const checkpoint = createMainThreadCheckpoint(this.workScheduler, this.waitForBackground);
      await checkpoint();
      if (signal?.aborted || !isCurrent()) return "cancelled";
      const value = snapshot();
      const currentCheckpoint = async (): Promise<void> => {
        if (signal?.aborted || !isCurrent()) throw new Error("Obsolete export integrity check.");
        await checkpoint();
        if (signal?.aborted || !isCurrent()) throw new Error("Obsolete export integrity check.");
      };
      const digest = await this.#metadata.digest(value, currentCheckpoint, signal);
      matches = sameDocumentIntegrityManifest(
        workerManifest,
        deriveDocumentIntegrityManifestFromContentDigest(value, digest),
      );
    } catch {
      // An invalid authoritative snapshot is an integrity failure, never a writable state.
    }
    if (signal?.aborted || !isCurrent()) return "cancelled";
    if (matches) {
      this.#retryUsed = false;
      return "match";
    }
    if (this.#retryUsed) return "fail";
    this.#retryUsed = true;
    return "retry-full";
  }
}

export async function inspectIntegrityBoundExport(
  result: ExportSuccess,
  waitForBackground?: () => Promise<void>,
  workScheduler?: WorkScheduler,
) {
  const trusted = await adoptOwnedSvgOutput(result.output, result.outputHash, {
    ...(waitForBackground ? { waitForBackground } : {}),
    ...(workScheduler ? { workScheduler } : {}),
  });
  if (trusted.revision !== result.modelRevision) throw new TypeError("Export revision mismatch.");
  if (trusted.snapshotHash !== result.integrityManifest.contentDigest) {
    throw new TypeError("Export snapshot digest mismatch.");
  }
  return trusted;
}

export function createAutosaveExportIntegrity(
  options: AutosaveCoordinatorOptions,
): AutosaveExportIntegrity {
  return new AutosaveExportIntegrity(
    options.waitForBackground,
    options.documentSource.ownsIntegrityElement,
    options.workScheduler,
  );
}
