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
  readonly sliceBudgetMs?: () => number;
  readonly waitForBackground?: () => Promise<void>;
  currentRevision(): number;
}

export interface VerifiedExistingFilePreflight {
  readonly base: Extract<VaultBase, { type: "confirmed" }>;
  readonly content: string;
}

export async function saveExistingFile(
  prepared: PreparedSave,
  revisionSource: SaveRevisionSource,
  vault: ExistingFilePort,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  if (revisionSource.waitForBackground) await revisionSource.waitForBackground();
  validatePreparedOutput(prepared);
  const preflight = await readExistingFileWithinLimit(vault, prepared.path);
  if (!exactStringEqual(preflight, prepared.expectedBase)) {
    throw new SaveError("external-conflict");
  }
  return writeExistingFile(prepared, preflight, revisionSource, vault, verifier);
}

export async function saveExistingFileFromVerifiedPreflight(
  prepared: Omit<PreparedSave, "expectedBase">,
  expectedBase: Extract<VaultBase, { type: "confirmed" }>,
  preflight: VerifiedExistingFilePreflight,
  revisionSource: SaveRevisionSource,
  vault: ExistingFilePort,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  if (revisionSource.waitForBackground) await revisionSource.waitForBackground();
  validatePreparedOutput(prepared);
  if (
    preflight.base.revision !== expectedBase.revision ||
    preflight.base.outputHash !== expectedBase.outputHash
  ) {
    throw new SaveError("external-conflict");
  }
  return writeExistingFile(
    { ...prepared, expectedBase: preflight.content },
    preflight.content,
    revisionSource,
    vault,
    verifier,
  );
}

async function writeExistingFile(
  prepared: PreparedSave,
  preflight: string,
  revisionSource: SaveRevisionSource,
  vault: ExistingFilePort,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
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
