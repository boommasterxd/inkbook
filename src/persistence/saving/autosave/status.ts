import type { AutosaveStatus, FlushOutcome, FlushWaiter } from "./types";

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

export function resolveAutosaveWaiters(
  dirty: boolean,
  status: AutosaveStatus,
  waiters: FlushWaiter[],
): void {
  if (dirty && !isAutosaveSuspended(status) && status !== "retryable-error") return;
  const outcome = terminalAutosaveOutcome(dirty, status);
  for (const waiter of waiters.splice(0)) waiter.resolve(outcome);
}
