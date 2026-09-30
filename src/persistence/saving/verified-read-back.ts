import { SaveError } from "./save-errors";
import type {
  ExistingFilePort,
  MetadataGuardedFileRead,
  PersistedOutputVerifier,
} from "./save-ports";
import { readGuardedFileWithinLimit } from "./bounded-file-read";

export interface ConfirmedSave {
  readonly content: string;
  readonly revision: number;
  readonly outputHash: string;
  readonly readBack?: MetadataGuardedFileRead;
}

export async function readConfirmedSave(
  path: string,
  revision: number,
  outputHash: string,
  vault: ExistingFilePort,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  const readBack = await readGuardedFileWithinLimit(vault, path);
  return confirmReadBack(readBack, revision, outputHash, verifier);
}

export async function confirmReadBack(
  readBack: string | MetadataGuardedFileRead,
  revision: number,
  outputHash: string,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  const content = typeof readBack === "string" ? readBack : readBack.content;
  if (!(await verifier.verify(content, revision, outputHash))) {
    throw new SaveError("read-back-mismatch");
  }
  return { content, revision, outputHash, ...(typeof readBack === "string" ? {} : { readBack }) };
}
