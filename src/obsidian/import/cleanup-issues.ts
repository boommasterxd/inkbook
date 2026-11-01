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
): void {
  const sources = new Map(journal.sources.map((source) => [source.path, source.status]));
  const retained = new Set<string>();
  let count = 0;
  for (const issue of journal.issues) {
    const prefix = CLEANUP_ISSUE_PREFIXES.find((candidate) => issue.startsWith(candidate));
    const path = prefix === undefined ? undefined : issue.slice(prefix.length);
    if (path !== undefined && sources.has(path)) {
      if (
        journal.status === "undone" ||
        sources.get(path) === "cleaned" ||
        checked.has(path) ||
        retained.has(issue)
      )
        continue;
      retained.add(issue);
    }
    journal.issues[count++] = issue;
  }
  journal.issues.length = count;
  for (const issue of checked.values()) {
    if (issue !== undefined) journal.issues.push(issue);
  }
}
