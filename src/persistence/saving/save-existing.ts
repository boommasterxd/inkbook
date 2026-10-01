import { SaveError } from "./save-errors";
import type { ExistingFilePort, PersistedOutputVerifier } from "./save-ports";
import { readExistingFileWithinLimit } from "./bounded-file-read";
import { exactStringEqual } from "./exact-string-equality";
import { scanCanonicalRevisionPrefix } from "./revision-scan";
import { readConfirmedSave, type ConfirmedSave } from "./verified-read-back";
import type { VaultBase } from "../worker/protocol";
import { type PreparedOutput, validatePreparedOutput } from "./validated-prepared-output";

export type { ConfirmedSave } from "./verified-read-back";

export interface PreparedSave extends PreparedOutput {
  readonly path: string;
  readonly expectedBase: string;
}

export interface SaveRevisionSource {
  readonly waitForBackground?: () => Promise<void> | undefined;
  currentRevision(): number;
}

export interface VerifiedExistingFilePreflight {
  readonly base: Extract<VaultBase, { type: "confirmed" }>;
  readonly content: string;
}

interface ConfirmedPreflightEvidence {
  readonly expectedBase: Extract<VaultBase, { type: "confirmed" }>;
  readonly preflight: VerifiedExistingFilePreflight;
}

export async function saveExistingFile(
  prepared: PreparedSave,
  revisionSource: SaveRevisionSource,
  vault: ExistingFilePort,
  verifier: PersistedOutputVerifier,
  verified?: ConfirmedPreflightEvidence,
): Promise<ConfirmedSave> {
  const pending = revisionSource.waitForBackground?.();
  if (pending !== undefined) await pending;
  validatePreparedOutput(prepared);
  const preflight =
    verified?.preflight.content ?? (await readExistingFileWithinLimit(vault, prepared.path));
  const matchesBase =
    verified === undefined
      ? exactStringEqual(preflight, prepared.expectedBase)
      : verified.preflight.base.revision === verified.expectedBase.revision &&
        verified.preflight.base.outputHash === verified.expectedBase.outputHash;
  if (!matchesBase) {
    throw new SaveError("external-conflict");
  }
  if (revisionSource.currentRevision() !== prepared.revision) {
    throw new SaveError("stale-editor-revision");
  }

  let comparisonBase = preflight;
  try {
    await vault.process(prepared.path, (current) => {
      if (!exactStringEqual(current, comparisonBase)) {
        throw new SaveError("external-conflict");
      }
      if (scanCanonicalRevisionPrefix(prepared.output) !== prepared.revision) {
        throw new SaveError("read-back-mismatch");
      }
      if (revisionSource.currentRevision() !== prepared.revision) {
        throw new SaveError("stale-editor-revision");
      }
      return prepared.output;
    });
  } catch (error) {
    if (error instanceof SaveError) {
      throw error;
    }
    throw new SaveError("vault-write-failed");
  } finally {
    comparisonBase = "";
  }

  return readConfirmedSave(prepared.path, prepared.revision, prepared.outputHash, vault, verifier);
}

export function saveExistingFileFromVerifiedPreflight(
  prepared: Omit<PreparedSave, "expectedBase">,
  expectedBase: Extract<VaultBase, { type: "confirmed" }>,
  preflight: VerifiedExistingFilePreflight,
  revisionSource: SaveRevisionSource,
  vault: ExistingFilePort,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  return saveExistingFile(
    { ...prepared, expectedBase: preflight.content },
    revisionSource,
    vault,
    verifier,
    { expectedBase, preflight },
  );
}
