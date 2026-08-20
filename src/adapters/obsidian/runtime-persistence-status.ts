import type { RuntimePersistenceIssueStatusV1 } from "./runtime-persistence-external";

export function runtimePersistenceIssueStatusV1(
  external: RuntimePersistenceIssueStatusV1 | undefined,
  saveRetryAttempts: number,
): RuntimePersistenceIssueStatusV1 | null {
  if (saveRetryAttempts === 0) return external ?? null;
  return Object.freeze({
    conflict: external?.conflict ?? Object.freeze({ kind: "none" as const }),
    drift: external?.drift ?? Object.freeze({ kind: "none" as const }),
    retry: Object.freeze({
      action: "save" as const,
      attemptCount: saveRetryAttempts,
      kind: "available" as const,
    }),
  });
}
