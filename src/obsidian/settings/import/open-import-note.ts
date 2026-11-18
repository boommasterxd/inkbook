import type { App, Workspace, WorkspaceContainer, WorkspaceLeaf } from "obsidian";

export async function finishImportNoteHandoff(
  workspace: Workspace,
  leaf: WorkspaceLeaf,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly closeOwnerOnNoteOpen?: (() => void) | undefined;
  },
): Promise<void> {
  // The native close callback can run before Obsidian removes the child's modal and focus scope.
  await Promise.resolve();
  if (options.signal?.aborted === true || leaf.getContainer().win.closed) return;
  options.closeOwnerOnNoteOpen?.();
  workspace.setActiveLeaf(leaf, { focus: true });
}

/** Opens an exact vault file in the workspace that owns the import dialog. */
export async function openImportNote(
  app: App,
  path: string,
  ownerWindow: Window,
): Promise<WorkspaceLeaf | undefined> {
  const file = app.vault.getFileByPath(path);
  if (file === null || file.extension !== "md") return undefined;
  const { workspace } = app;
  let root: WorkspaceContainer | undefined;
  if (workspace.rootSplit.win === ownerWindow) root = workspace.rootSplit;
  else {
    workspace.iterateAllLeaves((leaf) => {
      if (root !== undefined) return;
      const candidate = leaf.getContainer();
      if (candidate.win === ownerWindow) root = candidate;
    });
  }
  if (root === undefined) return undefined;
  const leaf = workspace.getMostRecentLeaf(root) ?? workspace.createLeafInParent(root, 0);
  if (leaf.getContainer() !== root) return undefined;
  await leaf.openFile(file, { active: false });
  return leaf;
}
