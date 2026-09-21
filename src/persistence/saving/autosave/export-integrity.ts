import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { ExportSuccess } from "../../worker/protocol";
import {
  deriveDocumentIntegrityManifestAsync,
  sameDocumentIntegrityManifest,
  type DocumentIntegrityManifest,
} from "../../serialization/public";
import { createMainThreadCheckpoint } from "../../scheduling/main-thread-checkpoint";
import { inspectTrustedSvgOutput } from "../../scheduling/trusted-svg-output";

export type ExportIntegrityDecision = "cancelled" | "fail" | "match" | "retry-full";

export class AutosaveExportIntegrity {
  #retryUsed = false;

  public constructor(
    readonly waitForBackground?: () => Promise<void>,
    readonly sliceBudgetMs?: () => number,
  ) {}

  public async verify(
    snapshot: () => InkSnapshotV1,
    workerManifest: DocumentIntegrityManifest,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
  ): Promise<ExportIntegrityDecision> {
    let matches = false;
    try {
      if (this.waitForBackground) await this.waitForBackground();
      if (signal?.aborted || !isCurrent()) return "cancelled";
      matches = sameDocumentIntegrityManifest(
        workerManifest,
        await deriveDocumentIntegrityManifestAsync(snapshot(), {
          checkpoint: createMainThreadCheckpoint(this.sliceBudgetMs, this.waitForBackground),
          ...(signal === undefined ? {} : { signal }),
        }),
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
  sliceBudgetMs?: () => number,
) {
  const trusted = await inspectTrustedSvgOutput(result.output, result.outputHash, {
    ...(sliceBudgetMs ? { sliceBudgetMs } : {}),
    ...(waitForBackground ? { waitForBackground } : {}),
  });
  if (trusted.revision !== result.modelRevision) throw new TypeError("Export revision mismatch.");
  if (trusted.snapshotHash !== result.integrityManifest.contentDigest) {
    throw new TypeError("Export snapshot digest mismatch.");
  }
  return trusted;
}
