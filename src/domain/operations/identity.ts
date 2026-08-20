import type { HistoryEntryId, HistoryEpoch, OperationId } from "./types";

const OPERATION_ID_PATTERN = /^op_[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const HISTORY_ENTRY_ID_PATTERN = /^he_[0-7][0-9a-hjkmnp-tv-z]{25}$/u;

export function isOperationId(value: unknown): value is OperationId {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value);
}

export function isHistoryEntryId(value: unknown): value is HistoryEntryId {
  return typeof value === "string" && HISTORY_ENTRY_ID_PATTERN.test(value);
}

export function isHistoryEpoch(value: unknown): value is HistoryEpoch {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function parseOperationId(value: string): OperationId {
  if (!isOperationId(value)) {
    throw new TypeError("Invalid operation ID syntax.");
  }
  return value;
}

export function parseHistoryEntryId(value: string): HistoryEntryId {
  if (!isHistoryEntryId(value)) {
    throw new TypeError("Invalid history entry ID syntax.");
  }
  return value;
}

export function createHistoryEpoch(value: number): HistoryEpoch {
  if (!isHistoryEpoch(value)) {
    throw new RangeError("A history epoch must be a positive safe integer.");
  }
  return value;
}
