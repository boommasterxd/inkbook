import type { ImportJournalStore } from "./journal";
import type { InkImportPorts, InkImportSourceRecord } from "./types";

async function cleanupSource(options: {
  readonly ports: InkImportPorts;
  readonly store: ImportJournalStore;
  readonly source: InkImportSourceRecord;
}): Promise<void> {
  const { ports, store, source } = options;
  const wasImported = store.journal.notes.some((note) =>
    note.patches.some((patch) => patch.sourcePath === source.path && patch.status === "applied"),
  );
  if (!wasImported) return;
  const backup = await ports.read(source.backupPath);
  if (
    (await ports.hash(backup)) !== source.hash ||
    (await ports.hash(await ports.read(source.path))) !== source.hash ||
    (await ports.hash(await ports.read(source.targetPath))) !== source.outputHash
  ) {
    store.journal.issues.push(`Cleanup skipped changed source or backup: ${source.path}`);
    return;
  }
  if ((await ports.referenceState(source.path)) !== "unreferenced") {
    store.journal.issues.push(`Cleanup skipped referenced or unverified source: ${source.path}`);
    return;
  }
  await ports.convert(backup, { legacyWriting: /\.writing$/iu.test(source.path) });
  source.cleanupIntent = true;
  await store.save();
  if (
    (await ports.hash(await ports.read(source.path))) !== source.hash ||
    (await ports.hash(await ports.read(source.targetPath))) !== source.outputHash ||
    (await ports.referenceState(source.path)) !== "unreferenced"
  ) {
    delete source.cleanupIntent;
    store.journal.issues.push(`Cleanup source changed before removal: ${source.path}`);
    await store.save();
    return;
  }
  if (!(await ports.trash(source.path, backup))) throw new Error("Source changed before removal.");
  if (ports.listFiles().some((file) => file.path === source.path))
    throw new Error("Source removal readback failed.");
  source.status = "cleaned";
  delete source.cleanupIntent;
  await store.save();
}

export async function cleanupInkImport(
  ports: InkImportPorts,
  store: ImportJournalStore,
  signal?: AbortSignal,
): Promise<void> {
  if (store.journal.status === "undone") return;
  for (const source of store.journal.sources) {
    if (signal?.aborted === true) break;
    if (source.status !== "created") continue;
    await ports.workScheduler.checkpoint(undefined, "background");
    try {
      await cleanupSource({ ports, store, source });
    } catch {
      store.journal.issues.push(`Cleanup read or removal failure: ${source.path}`);
      await store.save();
    }
  }
  await store.save();
}
