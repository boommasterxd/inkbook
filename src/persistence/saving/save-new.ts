import { SaveError } from "./save-errors";
import type { ExistingFilePort, NewFilePort, PersistedOutputVerifier } from "./save-ports";
import type { PreparedSave, SaveRevisionSource } from "./save-existing";
import { confirmReadBack, type ConfirmedSave } from "./verified-read-back";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import { validatePreparedOutput } from "./validated-prepared-output";

export async function saveNewFile(
  prepared: Omit<PreparedSave, "expectedBase">,
  revisionSource: SaveRevisionSource,
  vault: ExistingFilePort & NewFilePort,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  if (revisionSource.currentRevision() !== prepared.revision) {
    throw new SaveError("stale-editor-revision");
  }
  await validatePreparedOutput(prepared);
  let readBack: string;
  try {
    readBack = (
      await vault.createAndReadBack(
        prepared.path,
        prepared.output,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      )
    ).content;
  } catch {
    throw new SaveError("vault-write-failed");
  }
  return confirmReadBack(readBack, prepared.revision, prepared.outputHash, verifier);
}
