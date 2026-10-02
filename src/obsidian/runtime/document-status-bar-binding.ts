import { MarkdownView, type Plugin, type Workspace } from "obsidian";

import type { ObsidianWorkspaceRuntime } from "../embeds/workspace-runtime";
import type { InkbookSettingsStore } from "../settings/storage";
import { mountDocumentStatusBar } from "./document-status-bar";

/** Resolves stable ownership once when an authoritative editor binding is created. */
export function resolveDocumentStatusPane(
  workspace: Pick<Workspace, "getLeavesOfType">,
  root: HTMLElement,
): HTMLElement | undefined {
  return workspace.getLeavesOfType("markdown").find((leaf) => leaf.view.containerEl.contains(root))
    ?.view.containerEl;
}

/** Publishes active public pane identity through the plugin-owned status lifetime. */
export function registerDocumentStatusBar(
  plugin: Plugin,
  runtime: ObsidianWorkspaceRuntime,
  settings: InkbookSettingsStore,
): () => void {
  const item = plugin.addStatusBarItem();
  item.classList.add("inkbook-status-bar-item");
  const statusBar = mountDocumentStatusBar(
    item,
    runtime.documentStatus,
    runtime.getMotionPreference,
  );
  let disposed = false;
  const refreshPane = (): void => {
    if (disposed) return;
    runtime.documentStatus.setActivePane(
      plugin.app.workspace.getActiveViewOfType(MarkdownView)?.containerEl ?? null,
    );
  };
  refreshPane();
  plugin.app.workspace.onLayoutReady(refreshPane);
  plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", refreshPane));
  const unsubscribeSettings = settings.subscribeDeviceSettings(() => {
    if (disposed) return;
    statusBar.refreshMotion();
  });
  const release = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeSettings();
    statusBar.dispose();
    item.remove();
  };
  plugin.register(release);
  return release;
}
