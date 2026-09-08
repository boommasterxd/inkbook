import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { ExportSuccess } from "../../worker/protocol";
import {
  deriveDocumentIntegrityManifestAsync,
  sameDocumentIntegrityManifest,
  type DocumentIntegrityManifest,
} from "../../serialization/public";
import { yieldToMainThread } from "../../scheduling/main-thread-yield";
import { inspectTrustedSvgOutput } from "../../scheduling/trusted-svg-output";

export type ExportIntegrityDecision = "fail" | "match" | "retry-full";

const MAIN_THREAD_SLICE_MS = 4;

export class AutosaveExportIntegrity {
  #retryUsed = false;

  public async verify(
    snapshot: () => InkSnapshotV1,
    workerManifest: DocumentIntegrityManifest,
    signal?: AbortSignal,
  ): Promise<ExportIntegrityDecision> {
    try {
      if (
        sameDocumentIntegrityManifest(
          workerManifest,
          await deriveDocumentIntegrityManifestAsync(snapshot(), {
            checkpoint: createMainThreadCheckpoint(),
            ...(signal === undefined ? {} : { signal }),
          }),
        )
      ) {
        this.#retryUsed = false;
        return "match";
      }
    } catch {
      // An invalid authoritative snapshot is an integrity failure, never a writable state.
    }
    if (this.#retryUsed) return "fail";
    this.#retryUsed = true;
    return "retry-full";
  }
}

export async function inspectIntegrityBoundExport(result: ExportSuccess) {
  const trusted = await inspectTrustedSvgOutput(result.output, result.outputHash);
  if (trusted.revision !== result.modelRevision) throw new TypeError("Export revision mismatch.");
  if (trusted.snapshotHash !== result.integrityManifest.contentDigest) {
    throw new TypeError("Export snapshot digest mismatch.");
  }
  return trusted;
}

function createMainThreadCheckpoint(): () => Promise<void> {
  let deadline = performance.now() + MAIN_THREAD_SLICE_MS;
  return async () => {
    if (performance.now() < deadline) return;
    await yieldToMainThread();
    deadline = performance.now() + MAIN_THREAD_SLICE_MS;
  };
}
