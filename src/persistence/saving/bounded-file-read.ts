import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";

import type { ExistingFilePort, MetadataGuardedFileRead } from "./save-ports";
import { VerifiedMetadataGuardedFileRead } from "./verified-file-read";
import { utf8ByteLengthWithinLimit } from "../scheduling/utf8-byte-length";
import { MetadataGuardedFileReadCandidate } from "./metadata-guarded-file-read";

export async function readExistingFileWithinLimit(
  vault: ExistingFilePort,
  path: string,
): Promise<string> {
  const read = await readGuardedFileWithinLimit(vault, path);
  if (
    MetadataGuardedFileReadCandidate.isOwned(read) &&
    utf8ByteLengthWithinLimit(read.content, FILE_SCHEMA_LIMITS.totalInputBytes) !==
      read.identity.size
  ) {
    throw new RangeError("The vault file size does not match its actual UTF-8 bytes.");
  }
  return read.content;
}

export async function readGuardedFileWithinLimit(
  vault: ExistingFilePort,
  path: string,
): Promise<MetadataGuardedFileRead> {
  const read = await (vault.readForVerification?.(path, FILE_SCHEMA_LIMITS.totalInputBytes) ??
    vault.readWithMetadataGuard(path, FILE_SCHEMA_LIMITS.totalInputBytes));
  if (!Number.isSafeInteger(read.identity.size) || read.identity.size < 0) {
    throw new RangeError("The vault reported an invalid file size.");
  }
  if (read.identity.size > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new RangeError("The vault file exceeds the input byte limit.");
  }
  if (read.content.length > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new RangeError("The vault file exceeds the input byte limit after reading.");
  }
  if (
    !VerifiedMetadataGuardedFileRead.isVerified(read) &&
    !MetadataGuardedFileReadCandidate.isOwned(read) &&
    utf8ByteLengthWithinLimit(read.content, FILE_SCHEMA_LIMITS.totalInputBytes) === null
  ) {
    throw new RangeError("The vault file exceeds the input byte limit after reading.");
  }
  if (read.isCurrent?.() === false) throw new Error("The guarded host read is obsolete.");
  return read;
}
