import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { sha256TextChunked } from "../../persistence/serialization/sha256";
import { normalizeVaultPath } from "../vault/boundary";
import { ObsidianVaultFileAdapter } from "../vault/file-adapter";
import { ObsidianVaultFolderAdapter } from "../vault/folder-adapter";
import { ObsidianManagedFileAdapter } from "../vault/managed-files";
import { ObsidianLinkAdapter } from "../vault/links";
import { currentImportNote, importNoteViews, writeOpenImportNote } from "./editor-write";
import { inkImportReferenceState } from "./reference-state";
import { createImportTrash } from "./safe-trash";
import type { InkImportPorts } from "./types";

export function createObsidianInkImportPorts(options: {
  readonly app: App;
  readonly workScheduler: WorkScheduler;
  readonly convert: InkImportPorts["convert"];
  readonly createRunId: () => string;
}): InkImportPorts {
  const { app, workScheduler } = options;
  const files = new ObsidianVaultFileAdapter(
    app.vault,
    { file: TFile, folder: TFolder },
    normalizePath,
  );
  const folders = new ObsidianVaultFolderAdapter(app.vault, TFolder, normalizePath);
  const managed = new ObsidianManagedFileAdapter(app.fileManager, files, normalizePath);
  const links = new ObsidianLinkAdapter({
    classes: { file: TFile, folder: TFolder },
    fileManager: app.fileManager,
    files,
    metadataCache: app.metadataCache,
    normalizePath,
    resolution: { isResolved: () => false },
  });
  const ports: InkImportPorts = {
    workScheduler,
    listFiles: () =>
      app.vault.getFiles().map((file) => ({ path: file.path, size: file.stat.size })),
    read: async (path) => {
      const normalized = normalizeVaultPath(path, normalizePath);
      const current = /\.md$/iu.test(normalized) ? currentImportNote(app, normalized) : undefined;
      return current ?? files.read(normalized);
    },
    create: async (path, content) => {
      await ensureParents(path, folders);
      const created = await files.createOwnedAndReadBack(
        path,
        content,
        FILE_SCHEMA_LIMITS.totalInputBytes,
      );
      if (created.readBack.content !== content || !created.isCurrent())
        throw new Error("Import write verification failed.");
    },
    compareAndWrite: async (path, expected, content) => {
      if (/\.md$/iu.test(path)) {
        const result = await writeOpenImportNote({
          app,
          path,
          expected,
          next: content,
          workScheduler,
        });
        if (result !== undefined) return result && (await files.read(path)) === content;
      }
      let applied = false;
      const processed = await files.process(path, (current) => {
        if (current !== expected) return current;
        if (/\.md$/iu.test(path) && importNoteViews(app, path).length > 0) return current;
        applied = true;
        return content;
      });
      return applied && processed === content && (await files.read(path)) === content;
    },
    trash: createImportTrash(app, files, managed),
    resolveLink: (link, notePath) => {
      try {
        const file = app.metadataCache.getFirstLinkpathDest(
          link,
          normalizeVaultPath(notePath, normalizePath),
        );
        return file instanceof TFile ? normalizeVaultPath(file.path, normalizePath) : undefined;
      } catch {
        return undefined;
      }
    },
    generateEmbed: (path, notePath, description) =>
      links.generateEmbed(path, notePath, description),
    hash: (content) => sha256TextChunked(content, () => workScheduler.checkpoint()),
    convert: options.convert,
    createRunId: options.createRunId,
    now: () => new Date().toISOString(),
    referenceState: (path, signal) => inkImportReferenceState(ports, path, signal),
  };
  return ports;
}

async function ensureParents(path: string, folders: ObsidianVaultFolderAdapter): Promise<void> {
  const normalized = normalizeVaultPath(path, normalizePath);
  const parts = normalized.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    await folders.createFolder(parts.slice(0, index).join("/"));
  }
}
