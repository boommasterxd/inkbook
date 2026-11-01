import type { ImportJournalStore } from "./journal";
import type { InkImportNoteRecord, InkImportPorts } from "./types";
import type { InkImportSourceRecord } from "./types";

async function reconcileSource(
  ports: InkImportPorts,
  source: InkImportSourceRecord,
  files: ReadonlySet<string>,
): Promise<void> {
  if (source.cleanupIntent === true) {
    if (!files.has(source.path)) source.status = "cleaned";
    else if ((await ports.hash(await ports.read(source.path))) !== source.hash)
      source.status = "conflict";
    delete source.cleanupIntent;
  }
  if (source.status !== "intent" || !files.has(source.targetPath)) return;
  source.status =
    (await ports.hash(await ports.read(source.targetPath))) === source.outputHash
      ? "created"
      : "conflict";
}

function reconcileUndo(note: InkImportNoteRecord, hash: string): void {
  const intent = note.undoIntent;
  if (intent === undefined) return;
  if (hash === intent.resultHash) {
    for (const index of intent.patchIndexes) {
      const patch = note.patches[index];
      if (patch !== undefined) patch.status = "undone";
    }
    note.status = note.patches.every((patch) => patch.status === "undone") ? "undone" : "conflict";
  } else if (hash !== intent.expectedHash) note.status = "conflict";
  delete note.undoIntent;
}

export async function reconcileJournal(
  ports: InkImportPorts,
  store: ImportJournalStore,
): Promise<void> {
  const files = new Set(ports.listFiles().map((file) => file.path));
  const before = JSON.stringify(store.journal);
  for (const source of store.journal.sources) {
    await ports.workScheduler.checkpoint(undefined, "background");
    await reconcileSource(ports, source, files);
  }
  for (const note of store.journal.notes) {
    await ports.workScheduler.checkpoint(undefined, "background");
    if (!files.has(note.path)) {
      note.status = "conflict";
      continue;
    }
    if (note.status !== "intent" && note.undoIntent === undefined) continue;
    const hash = await ports.hash(await ports.read(note.path));
    if (note.undoIntent !== undefined) {
      reconcileUndo(note, hash);
      continue;
    }
    if (hash === note.importedHash) {
      note.status = "applied";
      for (const patch of note.patches) patch.status = "applied";
    } else if (hash !== note.originalHash) note.status = "conflict";
  }
  if (store.journal.status === "running") store.journal.status = "cancelled";
  if (before !== JSON.stringify(store.journal)) await store.save();
}
