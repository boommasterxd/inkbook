import { RECOVERY_STORE_LIMITS_V1 } from "../../application/recovery";
import type { IndexedDbRecoveryLimits } from "./types";

const DEFAULT_MAX_QUEUED_OPERATIONS = 64;
const DEFAULT_MAX_QUEUED_BYTES = RECOVERY_STORE_LIMITS_V1.maxGlobalBytes;
const MAXIMUM_LIMITS: IndexedDbRecoveryLimits = Object.freeze({
  directSuccessors: RECOVERY_STORE_LIMITS_V1.maxDirectSuccessorsPerBase,
  globalBytes: RECOVERY_STORE_LIMITS_V1.maxGlobalBytes,
  globalRecords: RECOVERY_STORE_LIMITS_V1.maxGlobalRecords,
  noteBytes: RECOVERY_STORE_LIMITS_V1.maxNoteBytes,
  noteRecords: RECOVERY_STORE_LIMITS_V1.maxNoteRecords,
  queuedBytes: DEFAULT_MAX_QUEUED_BYTES,
  queuedOperations: DEFAULT_MAX_QUEUED_OPERATIONS,
});

export function resolveRecoveryStoreLimits(
  overrides: Partial<IndexedDbRecoveryLimits> | undefined,
): IndexedDbRecoveryLimits {
  const limits = {
    directSuccessors:
      overrides?.directSuccessors ??
      RECOVERY_STORE_LIMITS_V1.maxDirectSuccessorsPerBase,
    globalBytes:
      overrides?.globalBytes ?? RECOVERY_STORE_LIMITS_V1.maxGlobalBytes,
    globalRecords:
      overrides?.globalRecords ?? RECOVERY_STORE_LIMITS_V1.maxGlobalRecords,
    noteBytes: overrides?.noteBytes ?? RECOVERY_STORE_LIMITS_V1.maxNoteBytes,
    noteRecords:
      overrides?.noteRecords ?? RECOVERY_STORE_LIMITS_V1.maxNoteRecords,
    queuedBytes: overrides?.queuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
    queuedOperations:
      overrides?.queuedOperations ?? DEFAULT_MAX_QUEUED_OPERATIONS,
  };
  const configured = Object.entries(limits) as readonly [
    keyof IndexedDbRecoveryLimits,
    number,
  ][];
  if (
    configured.some(([key, value]) => !validLimit(value, MAXIMUM_LIMITS[key]))
  ) {
    throw new RangeError(
      "Recovery store limits must be positive safe integers at or below product maxima.",
    );
  }
  return limits;
}

function validLimit(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
