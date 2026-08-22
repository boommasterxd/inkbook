import type { AutosaveStatus, FlushOutcome } from "./types";

export function isAutosaveSuspended(status: AutosaveStatus): boolean {
  return (
    status === "conflict" || status === "executor-failed" || status === "verification-required"
  );
}

export function terminalAutosaveOutcome(dirty: boolean, status: AutosaveStatus): FlushOutcome {
  if (!dirty) return "clean";
  if (status === "conflict") return "conflict";
  if (status === "executor-failed") return "executor-failed";
  if (status === "retryable-error") return "retryable-error";
  return "verification-required";
}
