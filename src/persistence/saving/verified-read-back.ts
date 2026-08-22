import { SaveError } from "./save-errors";
import type { ExistingFilePort, PersistedOutputVerifier } from "./save-ports";
import { readExistingFileWithinLimit } from "./bounded-file-read";

export interface ConfirmedSave {
  readonly content: string;
  readonly revision: number;
  readonly outputHash: string;
}

export async function readConfirmedSave(
  path: string,
  revision: number,
  outputHash: string,
  vault: ExistingFilePort,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  const readBack = await readExistingFileWithinLimit(vault, path);
  return confirmReadBack(readBack, revision, outputHash, verifier);
}

export async function confirmReadBack(
  readBack: string,
  revision: number,
  outputHash: string,
  verifier: PersistedOutputVerifier,
): Promise<ConfirmedSave> {
  if (!(await verifier.verify(readBack, revision, outputHash))) {
    throw new SaveError("read-back-mismatch");
  }
  return { content: readBack, revision, outputHash };
}
