import { SaveError } from "./save-errors";
import type {
  ExistingFilePort,
  MetadataGuardedFileRead,
  PersistedOutputVerifier,
} from "./save-ports";
import { readGuardedFileWithinLimit } from "./bounded-file-read";
import { VerifiedMetadataGuardedFileRead } from "./verified-file-read";
import { utf8ByteLengthWithinLimit } from "../scheduling/utf8-byte-length";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";

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
  const guarded = typeof readBack !== "string";
  if (guarded && readBack.isCurrent?.() === false) throw new SaveError("read-back-mismatch");
  if (
    guarded &&
    verifier.verifyRead === undefined &&
    !VerifiedMetadataGuardedFileRead.isVerified(readBack) &&
    utf8ByteLengthWithinLimit(content, FILE_SCHEMA_LIMITS.totalInputBytes) !==
      readBack.identity.size
  ) {
    throw new SaveError("read-back-mismatch");
  }
  const valid =
    guarded && verifier.verifyRead !== undefined
      ? await verifier.verifyRead(readBack, revision, outputHash)
      : await verifier.verify(content, revision, outputHash);
  if (!valid || (guarded && readBack.isCurrent?.() === false)) {
    throw new SaveError("read-back-mismatch");
  }
  return {
    content,
    revision,
    outputHash,
    ...(guarded
      ? {
          readBack: VerifiedMetadataGuardedFileRead.fromVerifiedRead(readBack),
        }
      : {}),
  };
}
