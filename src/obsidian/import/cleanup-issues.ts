import { filterImportIssues, recordImportIssue, type ImportDiagnostic } from "./diagnostics";
import type { InkImportJournal } from "./types";

const CLEANUP_ISSUE_PREFIXES = [
  "Cleanup skipped changed source or backup: ",
  "Cleanup skipped referenced or unverified source: ",
  "Cleanup source changed before removal: ",
  "Cleanup read or removal failure: ",
];

export function refreshCleanupIssues(
  journal: InkImportJournal,
  checked: ReadonlyMap<string, string | undefined> = new Map(),
  details: ReadonlyMap<string, ImportDiagnostic> = new Map(),
): void {
  const sources = new Map(journal.sources.map((source) => [source.path, source.status]));
  const retained = new Set<string>();
  filterImportIssues(journal, (issue) => {
    const prefix = CLEANUP_ISSUE_PREFIXES.find((candidate) => issue.startsWith(candidate));
    const path = prefix === undefined ? undefined : issue.slice(prefix.length);
    if (path !== undefined && sources.has(path)) {
      if (
        journal.status === "undone" ||
        sources.get(path) === "cleaned" ||
        checked.has(path) ||
        retained.has(issue)
      )
        return false;
      retained.add(issue);
    }
    return true;
  });
  for (const [path, issue] of checked) {
    if (issue === undefined) continue;
    const diagnostic = details.get(path);
    if (diagnostic === undefined) journal.issues.push(issue);
    else recordImportIssue(journal, issue, diagnostic);
  }
}
