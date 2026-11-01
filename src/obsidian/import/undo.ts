import { createVerified, type ImportJournalStore } from "./journal";
import { applyImportPatches, reverseImportPatches, withImportedContexts } from "./patches";
import { resolveInkReferences } from "./references";
import type { InkImportNoteRecord, InkImportPorts } from "./types";

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
  for (const path of blocked) store.journal.issues.push(`Original restoration conflict: ${path}`);
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
  if (remaining.some((patch) => originalSources.get(patch.start) !== patch.sourcePath)) {
    const issue = `Original reference resolution changed: ${note.path}`;
    if (!store.journal.issues.includes(issue)) store.journal.issues.push(issue);
  }
  const planned = eligible.map((patch) => ({ ...patch }));
  const next = await reverseImportPatches(current, planned, ports.workScheduler);
  const changed = planned.filter((patch) => patch.status === "undone");
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
    store.journal.issues.push(`Undo conflict: ${note.path}`);
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
      store.journal.issues.push(`Undo read or write failure: ${note.path}`);
      await store.save();
    }
  }
  store.journal.status = stopped()
    ? "cancelled"
    : store.journal.notes.every((note) => note.status === "undone")
      ? "undone"
      : "conflict";
  await store.save();
}
