/** Stable companion metadata leaves legacy journal text and recovery evidence intact. */
export const IMPORT_DIAGNOSTIC_CODES = [
  "missingSource",
  "unresolvedReference",
  "invalidSource",
  "unreadableNote",
  "scanTruncated",
  "writeConflict",
  "restoreConflict",
  "undoBlockedOriginal",
  "undoChangedLink",
  "undoChangedEmbed",
  "undoSaveConflict",
  "undoReadFailure",
  "cleanupChanged",
  "cleanupReferenced",
  "cleanupRace",
  "cleanupFailure",
  "historyUnreadable",
] as const;
export type ImportDiagnosticCode = (typeof IMPORT_DIAGNOSTIC_CODES)[number];
export interface ImportDiagnostic {
  readonly code: ImportDiagnosticCode;
  readonly path?: string;
}
export function validImportDiagnostics(value: unknown, count: number): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= count &&
      value.every((item: unknown) => {
        if (item === null) return true;
        if (typeof item !== "object" || !("code" in item)) return false;
        return (
          typeof item.code === "string" &&
          IMPORT_DIAGNOSTIC_CODES.some((code) => code === item.code) &&
          (!("path" in item) || (typeof item.path === "string" && item.path.length <= 1024))
        );
      }))
  );
}
export function recordImportIssue(
  journal: { issues: string[]; issueDetails?: (ImportDiagnostic | null)[] },
  message: string,
  diagnostic: ImportDiagnostic,
  deduplicate = true,
): void {
  if (deduplicate && journal.issues.includes(message)) return;
  journal.issueDetails ??= [];
  while (journal.issueDetails.length < journal.issues.length) journal.issueDetails.push(null);
  journal.issueDetails.push(diagnostic);
  journal.issues.push(message);
}
export function filterImportIssues(
  journal: { issues: string[]; issueDetails?: (ImportDiagnostic | null)[] },
  keep: (issue: string) => boolean,
): void {
  let count = 0;
  for (let index = 0; index < journal.issues.length; index += 1) {
    const issue = journal.issues[index]!;
    if (!keep(issue)) continue;
    journal.issues[count] = issue;
    if (journal.issueDetails !== undefined)
      journal.issueDetails[count] = journal.issueDetails[index] ?? null;
    count += 1;
  }
  journal.issues.length = count;
  if (journal.issueDetails !== undefined) journal.issueDetails.length = count;
}
