import { MarkdownView, TFile, type App } from "obsidian";

export async function readMarkdownExportSource(
  app: Pick<App, "workspace" | "vault">,
  sourcePath: string,
): Promise<string | undefined> {
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active?.file?.path === sourcePath && active.getMode() === "source")
    return active.editor.getValue();
  const file = app.vault.getAbstractFileByPath(sourcePath);
  return file instanceof TFile ? app.vault.cachedRead(file) : undefined;
}
