import type { App } from "obsidian";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/constants";
import type { ObsidianVaultFileAdapter } from "../vault/file-adapter";
import type { ObsidianManagedFileAdapter } from "../vault/managed-files";
import type { InkImportPorts } from "./types";

function hasOpenFile(app: App, path: string): boolean {
  let open = false;
  app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view.getState()["file"] === path) open = true;
  });
  return open;
}

/** Public trash has no cross-process transaction; verify immediately before handing it ownership. */
export function createImportTrash(
  app: App,
  files: ObsidianVaultFileAdapter,
  managed: ObsidianManagedFileAdapter,
): InkImportPorts["trash"] {
  return async (path, expected) => {
    if (hasOpenFile(app, path)) throw new Error("Close the original file before cleanup.");
    const file = files.resolveFile(path);
    let changed = false;
    const changedFile = (candidate: { readonly path: string }) => {
      if (candidate === file || candidate.path === path) changed = true;
    };
    const events = [
      app.vault.on("modify", changedFile),
      app.vault.on("rename", changedFile),
      app.vault.on("delete", changedFile),
    ];
    try {
      const read = await files.readWithMetadataGuard(path, FILE_SCHEMA_LIMITS.totalInputBytes);
      if (
        read.content !== expected ||
        changed ||
        hasOpenFile(app, path) ||
        files.resolveFile(path) !== file
      )
        return false;
      await managed.trash(path);
      return !app.vault.getFileByPath(path);
    } finally {
      for (const event of events) app.vault.offref(event);
    }
  };
}
