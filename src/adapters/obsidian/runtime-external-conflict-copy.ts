import type { ExternalSidecarConflictV1 } from "../../application/persistence/external-change";
import { isVaultFileCapability } from "./vault-sidecar/paths";

export const RUNTIME_CONFLICT_COPY_LIMIT_V1 = 3;

const CONFLICT_REVIEW_FILE_LIMIT = 10_000;
const SIDECAR_SUFFIX = ".inkbook.json";

export function hasRuntimeConflictCopyCapacityV1(
  files: readonly unknown[],
  conflict: ExternalSidecarConflictV1,
): boolean {
  const path = conflict.expectedBase.vaultRelativePath;
  const prefix = `${path.slice(0, -SIDECAR_SUFFIX.length)}.inkbook.conflict-`;
  let copies = 0;
  const inspected = Math.min(files.length, CONFLICT_REVIEW_FILE_LIMIT);
  for (let index = 0; index < inspected; index += 1) {
    const candidate = files[index];
    if (
      isVaultFileCapability(candidate) &&
      candidate.path.startsWith(prefix) &&
      candidate.path.endsWith(".json")
    ) {
      copies += 1;
      if (copies >= RUNTIME_CONFLICT_COPY_LIMIT_V1) return false;
    }
  }
  return files.length <= CONFLICT_REVIEW_FILE_LIMIT;
}
