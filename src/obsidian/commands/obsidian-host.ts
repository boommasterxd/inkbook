import { MarkdownView, normalizePath, TFile, TFolder, type App } from "obsidian";

import {
  type CreationPathResult,
  ObsidianCreationPathResolver,
  ObsidianLinkAdapter,
  ObsidianManagedFileAdapter,
  ObsidianVaultFileAdapter,
} from "../vault";
import type { PlacementFallbackFeedbackPort } from "./command-ports";

export function notifyPlacementFallback(
  fallback: CreationPathResult["fallback"],
  feedback: PlacementFallbackFeedbackPort,
): void {
  if (fallback === null) return;
  try {
    feedback.show(fallback);
  } catch {
    return;
  }
}

export function activeMarkdownOwnerWindow(app: App): Window {
  const ownerWindow =
    app.workspace.getActiveViewOfType(MarkdownView)?.containerEl.ownerDocument.defaultView;
  if (ownerWindow === undefined || ownerWindow === null) {
    throw new Error("The active Markdown view has no owning window.");
  }
  return ownerWindow;
}

export function createObsidianCommandVaultPorts(app: App, isMetadataResolved: () => boolean) {
  const classes = { file: TFile, folder: TFolder };
  const files = new ObsidianVaultFileAdapter(app.vault, classes, normalizePath);
  return {
    files,
    links: new ObsidianLinkAdapter({
      classes,
      fileManager: app.fileManager,
      files,
      metadataCache: app.metadataCache,
      normalizePath,
      resolution: { isResolved: isMetadataResolved },
    }),
    managedFiles: new ObsidianManagedFileAdapter(app.fileManager, files, normalizePath),
    placement: new ObsidianCreationPathResolver(app.fileManager, files, normalizePath),
  };
}
