import { createVerified, ImportJournalStore, runFolder, safeImportPath } from "./journal";
import { applyImportPatches, createImportPatch, withImportedContexts } from "./patches";
import { MAX_IMPORT_FILE_CHARS } from "./scan";
import type {
  InkImportNoteRecord,
  InkImportPorts,
  InkImportPreview,
  InkImportSource,
} from "./types";

function issue(store: ImportJournalStore, path: string): void {
  store.journal.issues.push(`Import conflict or write failure: ${path}`);
}

async function importSource(options: {
  readonly ports: InkImportPorts;
  readonly store: ImportJournalStore;
  readonly source: InkImportSource;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { ports, store, source, signal } = options;
  if (!safeImportPath(source.path) || !safeImportPath(source.targetPath))
    throw new Error("Invalid import path.");
  const original = await ports.read(source.path);
  if (original.length > MAX_IMPORT_FILE_CHARS || (await ports.hash(original)) !== source.hash) {
    issue(store, source.path);
    return;
  }
  const { svg, warnings } = await ports.convert(original, {
    legacyWriting: source.legacyWriting,
    ...(signal === undefined ? {} : { signal }),
  });
  signal?.throwIfAborted();
  if (svg.length > MAX_IMPORT_FILE_CHARS)
    throw new Error("Converted writing exceeds the safe size limit.");
  const backupPath = `${runFolder(store.journal.id)}/source-${store.journal.sources.length}.txt`;
  await createVerified(ports, backupPath, original);
  const record = {
    path: source.path,
    backupPath,
    hash: source.hash,
    targetPath: source.targetPath,
    outputHash: await ports.hash(svg),
    warnings,
    status: "intent" as const,
  };
  store.journal.sources.push(record);
  await store.save();
  const saved = store.journal.sources[store.journal.sources.length - 1];
  if (saved === undefined) throw new Error("Missing source write intent.");
  if ((await ports.hash(await ports.read(source.path))) !== source.hash) {
    saved.status = "conflict";
    issue(store, source.path);
    await store.save();
    return;
  }
  await createVerified(ports, source.targetPath, svg);
  saved.status = "created";
  await store.save();
}

async function importNote(options: {
  readonly ports: InkImportPorts;
  readonly store: ImportJournalStore;
  readonly preview: InkImportPreview;
  readonly path: string;
}): Promise<void> {
  const { ports, store, preview, path } = options;
  const note = await ports.read(path);
  if (note.length > MAX_IMPORT_FILE_CHARS || (await ports.hash(note)) !== preview.notes[path]) {
    issue(store, path);
    return;
  }
  const patches = [];
  for (const source of preview.sources) {
    const references = source.references.filter((ref) => ref.notePath === path);
    if (references.length === 0) continue;
    const imported = store.journal.sources.find(
      (record) => record.path === source.path && record.status === "created",
    );
    if (imported === undefined) continue;
    if (
      (await ports.hash(await ports.read(source.path))) !== source.hash ||
      (await ports.hash(await ports.read(source.targetPath))) !== imported.outputHash
    ) {
      issue(store, source.path);
      continue;
    }
    patches.push(
      ...references.map((ref) =>
        createImportPatch(ref, ports.generateEmbed(source.targetPath, path, ref.description), note),
      ),
    );
  }
  if (patches.length === 0) return;
  const next = applyImportPatches(note, patches);
  const backupPath = `${runFolder(store.journal.id)}/note-${store.journal.notes.length}.md`;
  await createVerified(ports, backupPath, note);
  const record: InkImportNoteRecord = {
    path,
    backupPath,
    originalHash: await ports.hash(note),
    importedHash: await ports.hash(next),
    patches: withImportedContexts(next, patches),
    status: "intent",
  };
  store.journal.notes.push(record);
  await store.save();
  for (const sourcePath of new Set(record.patches.map((patch) => patch.sourcePath))) {
    const source = store.journal.sources.find((entry) => entry.path === sourcePath);
    if (
      source === undefined ||
      (await ports.hash(await ports.read(source.path))) !== source.hash ||
      (await ports.hash(await ports.read(source.targetPath))) !== source.outputHash
    ) {
      record.status = "conflict";
      issue(store, sourcePath);
      await store.save();
      return;
    }
  }
  if (!(await ports.compareAndWrite(path, note, next)) || (await ports.read(path)) !== next) {
    record.status = "conflict";
    issue(store, path);
  } else {
    record.status = "applied";
    for (const patch of record.patches) patch.status = "applied";
  }
  await store.save();
}

export async function applyInkImport(
  ports: InkImportPorts,
  preview: InkImportPreview,
  signal?: AbortSignal,
): Promise<ImportJournalStore> {
  const store = new ImportJournalStore(ports, {
    version: 1,
    id: preview.id,
    createdAt: ports.now(),
    status: "running",
    sources: [],
    notes: [],
    issues: [],
  });
  await store.save();
  for (const source of preview.sources) {
    if (signal?.aborted === true) break;
    await ports.workScheduler.checkpoint(undefined, "background");
    try {
      await importSource({ ports, store, source, ...(signal === undefined ? {} : { signal }) });
    } catch {
      issue(store, source.path);
      await store.save();
    }
  }
  for (const path of Object.keys(preview.notes)) {
    if (signal?.aborted === true) break;
    await ports.workScheduler.checkpoint(undefined, "background");
    try {
      await importNote({ ports, store, preview, path });
    } catch {
      issue(store, path);
      await store.save();
    }
  }
  store.journal.status = signal?.aborted === true ? "cancelled" : "complete";
  await store.save();
  return store;
}
