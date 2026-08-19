import type { RecoveryOperationFailure } from "./types";

export function mapIndexedDbFailure(error: unknown): RecoveryOperationFailure {
  if (isNamedError(error, "QuotaExceededError")) {
    return { kind: "quota-exceeded" };
  }
  if (isNamedError(error, "AbortError")) {
    return { kind: "transaction-aborted" };
  }
  return { kind: "backend-unavailable" };
}

export function isSchemaVersionError(error: unknown): boolean {
  return isNamedError(error, "VersionError");
}

function isNamedError(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}
