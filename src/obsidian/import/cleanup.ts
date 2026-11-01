import type { ImportJournalStore } from "./journal";
import { refreshCleanupIssues } from "./cleanup-issues";
import type { InkImportPorts, InkImportSourceRecord } from "./types";

async function cleanupSource(options: {
  readonly ports: InkImportPorts;
  readonly store: ImportJournalStore;
  readonly source: InkImportSourceRecord;
}): Promise<string | undefined> {
  const { ports, store, source } = options;
  const backup = await ports.read(source.backupPath);
  if (
    (await ports.hash(backup)) !== source.hash ||
    (await ports.hash(await ports.read(source.path))) !== source.hash ||
    (await ports.hash(await ports.read(source.targetPath))) !== source.outputHash
  ) {
    return `Cleanup skipped changed source or backup: ${source.path}`;
  }
  if ((await ports.referenceState(source.path)) !== "unreferenced") {
    return `Cleanup skipped referenced or unverified source: ${source.path}`;
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
    await store.save();
    return `Cleanup source changed before removal: ${source.path}`;
  }
  if (!(await ports.trash(source.path, backup))) throw new Error("Source changed before removal.");
  if (ports.listFiles().some((file) => file.path === source.path))
    throw new Error("Source removal readback failed.");
  source.status = "cleaned";
  delete source.cleanupIntent;
  await store.save();
  return undefined;
}

export async function cleanupInkImport(
  ports: InkImportPorts,
  store: ImportJournalStore,
  signal?: AbortSignal,
): Promise<void> {
  if (store.journal.status === "undone") return;
  const stopped = (): boolean => signal?.aborted === true;
  const imported = new Set(
    store.journal.notes.flatMap((note) =>
      note.patches.filter((patch) => patch.status === "applied").map((patch) => patch.sourcePath),
    ),
  );
  const checked = new Map<string, string | undefined>();
  const recorded = new Set(store.journal.issues);
  for (const source of store.journal.sources) {
    if (stopped()) break;
    if (source.status !== "created" || !imported.has(source.path)) continue;
    await ports.workScheduler.checkpoint(undefined, "background");
    if (stopped()) break;
    try {
      checked.set(source.path, await cleanupSource({ ports, store, source }));
    } catch {
      const issue = `Cleanup read or removal failure: ${source.path}`;
      checked.set(source.path, issue);
      if (!recorded.has(issue)) {
        recorded.add(issue);
        store.journal.issues.push(issue);
      }
      await store.save();
    }
  }
  refreshCleanupIssues(store.journal, checked);
  await store.save();
}
