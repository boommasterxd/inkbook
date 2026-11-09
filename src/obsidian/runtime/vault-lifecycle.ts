import { TFile, type Plugin } from "obsidian";
import type { ObsidianWorkspaceRuntime } from "../embeds/workspace/workspace-runtime";
import type { ObsidianInkbookDocumentRecognition } from "../embeds/preview/document-recognition";

export function registerVaultLifecycle(
  plugin: Plugin,
  runtime: ObsidianWorkspaceRuntime,
  recognition: ObsidianInkbookDocumentRecognition,
): void {
  const handleFileChange = (file: unknown): void => {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "svg") return;
    recognition.deferRefresh(file.path);
    runtime.handleVaultModification(file.path, (output) => {
      if (output === undefined) recognition.invalidate(file.path);
      else
        recognition.acceptConfirmedOutput(
          file.path,
          output.content,
          output.outputHash,
          output.signature,
        );
    });
  };
  plugin.registerEvent(plugin.app.vault.on("create", handleFileChange));
  plugin.registerEvent(plugin.app.vault.on("modify", handleFileChange));
  plugin.registerEvent(
    plugin.app.vault.on("delete", (file) => {
      if (file instanceof TFile && file.extension.toLowerCase() === "svg")
        recognition.invalidate(file.path);
    }),
  );
  plugin.registerEvent(
    plugin.app.vault.on("rename", (file, oldPath) => {
      if (/\.svg$/iu.test(oldPath)) recognition.invalidate(oldPath);
      handleFileChange(file);
    }),
  );
}
