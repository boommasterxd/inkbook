import { recordImportIssue, filterImportIssues, type ImportDiagnostic } from "./diagnostics";
import { createVerified, type ImportJournalStore } from "./journal";
import { refreshCleanupIssues } from "./cleanup-issues";
import { applyImportPatches, reverseImportPatches, withImportedContexts } from "./patches";
import { resolveInkReferences } from "./references";
import type { InkImportNoteRecord, InkImportPorts } from "./types";

function recordIssue(store: ImportJournalStore, issue: string, diagnostic: ImportDiagnostic): void {
  recordImportIssue(store.journal, issue, diagnostic);
}
function retainIssues(store: ImportJournalStore, keep: (issue: string) => boolean): void {
  filterImportIssues(store.journal, keep);
}

function clearRestoredNoteIssues(store: ImportJournalStore): void {
  const restoredPaths = new Set(
    store.journal.notes.filter((note) => note.status === "undone").map((note) => note.path),
  );
  retainIssues(store, (issue) => {
    const separator = issue.lastIndexOf(": Undo ");
    return separator === -1 || !restoredPaths.has(issue.slice(0, separator));
  });
}

async function restoreCleanedSources(
  ports: InkImportPorts,
  store: ImportJournalStore,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const files = new Set(ports.listFiles().map((file) => file.path));
  for (const source of store.journal.sources) {
    if (files.has(source.path)) {
      if ((await ports.hash(await ports.read(source.path))) !== source.hash)
        blocked.add(source.path);
      continue;
    }
    const backup = await ports.read(source.backupPath);
    if ((await ports.hash(backup)) !== source.hash) {
      blocked.add(source.path);
      continue;
    }
    try {
      await createVerified(ports, source.path, backup);
      source.status = "created";
      await store.save();
    } catch {
      blocked.add(source.path);
    }
  }
  for (const path of blocked)
    recordIssue(store, `Original restoration conflict: ${path}`, { code: "restoreConflict", path });
  const resolvedIssues = new Set(
    store.journal.sources
      .filter((source) => !blocked.has(source.path))
      .map((source) => `Original restoration conflict: ${source.path}`),
  );
  retainIssues(store, (issue) => !resolvedIssues.has(issue));
  return blocked;
}

async function undoNote(options: {
  readonly ports: InkImportPorts;
  readonly store: ImportJournalStore;
  readonly note: InkImportNoteRecord;
  readonly blocked: ReadonlySet<string>;
}): Promise<void> {
  const { ports, store, note, blocked } = options;
  const current = await ports.read(note.path);
  if ((await ports.hash(current)) === note.originalHash) {
    note.status = "undone";
    for (const patch of note.patches) patch.status = "undone";
    delete note.undoIntent;
    await store.save();
    return;
  }
  const remaining = note.patches.filter((patch) => patch.status !== "undone");
  const original = await ports.read(note.backupPath);
  const references = await resolveInkReferences({
    note: original,
    notePath: note.path,
    resolve: ports.resolveLink.bind(ports),
    scheduler: ports.workScheduler,
  });
  const originalSources = new Map(
    references.map((reference) => [reference.start, reference.sourcePath]),
  );
  const canonical = applyImportPatches(original, remaining);
  const eligible = withImportedContexts(canonical, remaining).filter(
    (patch) =>
      !blocked.has(patch.sourcePath) && originalSources.get(patch.start) === patch.sourcePath,
  );
  if (remaining.some((patch) => blocked.has(patch.sourcePath))) {
    recordIssue(
      store,
      `${note.path}: Undo skipped embeds because an original file could not be safely restored. Check the original files and recovery backups.`,
      { code: "undoBlockedOriginal", path: note.path },
    );
  }
  if (remaining.some((patch) => originalSources.get(patch.start) !== patch.sourcePath)) {
    recordIssue(
      store,
      `${note.path}: Undo skipped embeds because an original link now points to a different file. Check the original links before retrying.`,
      { code: "undoChangedLink", path: note.path },
    );
  }
  const planned = eligible.map((patch) => ({ ...patch }));
  const next = await reverseImportPatches(current, planned, ports.workScheduler);
  const changed = planned.filter((patch) => patch.status === "undone");
  if (planned.some((patch) => patch.status === "conflict")) {
    recordIssue(
      store,
      `${note.path}: Undo skipped an imported embed that was changed, removed, or could not be uniquely identified with its surrounding text. Later edits were kept; review this note and its recovery backup.`,
      { code: "undoChangedEmbed", path: note.path },
    );
  }
  const patchIndexes = changed.map((patch) =>
    note.patches.findIndex(
      (candidate) => candidate.start === patch.start && candidate.sourcePath === patch.sourcePath,
    ),
  );
  if (changed.length === 0) {
    note.status = "conflict";
    await store.save();
    return;
  }
  note.undoIntent = {
    expectedHash: await ports.hash(current),
    resultHash: await ports.hash(next),
    patchIndexes,
  };
  await store.save();
  if (
    !(await ports.compareAndWrite(note.path, current, next)) ||
    (await ports.read(note.path)) !== next
  ) {
    note.status = "conflict";
    recordIssue(
      store,
      `${note.path}: Undo could not save because the note changed during restoration. Later edits were kept; review this note before retrying.`,
      { code: "undoSaveConflict", path: note.path },
    );
    await store.save();
    return;
  }
  for (const index of patchIndexes) {
    const patch = note.patches[index];
    if (patch !== undefined) patch.status = "undone";
  }
  delete note.undoIntent;
  note.status = note.patches.every((patch) => patch.status === "undone") ? "undone" : "conflict";
  await store.save();
}

export async function undoInkImport(
  ports: InkImportPorts,
  store: ImportJournalStore,
  signal?: AbortSignal,
): Promise<void> {
  const stopped = (): boolean => signal?.aborted === true;
  if (stopped()) return;
  const blocked = await restoreCleanedSources(ports, store);
  for (const note of store.journal.notes) {
    if (stopped()) break;
    if (note.status === "undone") continue;
    await ports.workScheduler.checkpoint(undefined, "background");
    try {
      await undoNote({ ports, store, note, blocked });
    } catch {
      note.status = "conflict";
      recordIssue(
        store,
        `${note.path}: Undo could not read or write this note or its recovery backup. Check that both are available before retrying.`,
        { code: "undoReadFailure", path: note.path },
      );
      await store.save();
    }
  }
  clearRestoredNoteIssues(store);
  store.journal.status = stopped()
    ? "cancelled"
    : store.journal.notes.every((note) => note.status === "undone")
      ? "undone"
      : "conflict";
  refreshCleanupIssues(store.journal);
  await store.save();
}
