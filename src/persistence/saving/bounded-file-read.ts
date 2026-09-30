import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";

import type { ExistingFilePort, MetadataGuardedFileRead } from "./save-ports";
import { VerifiedMetadataGuardedFileRead } from "./verified-file-read";
import { utf8ByteLengthWithinLimit } from "../scheduling/utf8-byte-length";

export async function readExistingFileWithinLimit(
  vault: ExistingFilePort,
  path: string,
): Promise<string> {
  return (await readGuardedFileWithinLimit(vault, path)).content;
}

export async function readGuardedFileWithinLimit(
  vault: ExistingFilePort,
  path: string,
): Promise<MetadataGuardedFileRead> {
  const read = await vault.readWithMetadataGuard(path, FILE_SCHEMA_LIMITS.totalInputBytes);
  if (!Number.isSafeInteger(read.identity.size) || read.identity.size < 0) {
    throw new RangeError("The vault reported an invalid file size.");
  }
  if (read.identity.size > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new RangeError("The vault file exceeds the input byte limit.");
  }
  if (
    !VerifiedMetadataGuardedFileRead.isVerified(read) &&
    utf8ByteLengthWithinLimit(read.content, FILE_SCHEMA_LIMITS.totalInputBytes) === null
  ) {
    throw new RangeError("The vault file exceeds the input byte limit after reading.");
  }
  return read;
}
