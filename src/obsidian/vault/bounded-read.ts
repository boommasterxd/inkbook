import type { TFile, Vault } from "obsidian";

import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import { utf8ByteLengthWithinLimit } from "../../persistence/scheduling/utf8-byte-length";

export async function readVaultFileWithinLimit(vault: Vault, file: TFile): Promise<string> {
  assertSizeWithinLimit(file.stat.size);
  const content = await vault.read(file);
  if (utf8ByteLengthWithinLimit(content, FILE_SCHEMA_LIMITS.totalInputBytes) === null) {
    throw new RangeError("The vault file exceeds the input byte limit after reading.");
  }
  return content;
}

function assertSizeWithinLimit(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("The vault reported an invalid file size.");
  }
  if (size > FILE_SCHEMA_LIMITS.totalInputBytes) {
    throw new RangeError("The vault file exceeds the input byte limit.");
  }
}
