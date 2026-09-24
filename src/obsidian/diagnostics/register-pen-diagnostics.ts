import { apiVersion, Notice, type Plugin } from "obsidian";

import { PenDiagnosticSession } from "./pen-diagnostic-session";

export function registerPenDiagnostics(plugin: Plugin): () => void {
  const workspace = plugin.app.workspace;
  const ownerWindow = workspace.containerEl.ownerDocument.defaultView;
  if (ownerWindow === null) return () => undefined;
  const session = new PenDiagnosticSession({
    vault: plugin.app.vault,
    ownerWindow,
    pluginVersion: plugin.manifest.version,
    obsidianVersion: apiVersion,
    notify: (message) => {
      new Notice(message, 8_000);
    },
  });
  const windows = new Map<Window, () => void>();
  const addWindow = (window: Window): void => {
    if (!windows.has(window) && windows.size < 8) windows.set(window, session.addWindow(window));
  };
  addWindow(ownerWindow);
  workspace.iterateAllLeaves((leaf) => {
    const window = leaf.view.containerEl.ownerDocument.defaultView;
    if (window !== null) addWindow(window);
  });
  plugin.registerEvent(
    workspace.on("window-open", (_workspaceWindow, window) => addWindow(window)),
  );
  plugin.registerEvent(
    workspace.on("window-close", (_workspaceWindow, window) => {
      windows.get(window)?.();
      windows.delete(window);
    }),
  );
  plugin.registerEvent(
    workspace.on("quit", (tasks) => {
      tasks.add(() => session.stop("quit"));
    }),
  );
  plugin.addCommand({
    id: "start-pen-diagnostics",
    name: "Start pen diagnostics",
    icon: "bug",
    checkCallback: (checking) => {
      if (!session.canStart) return false;
      if (!checking) void session.start();
      return true;
    },
  });
  plugin.addCommand({
    id: "stop-pen-diagnostics",
    name: "Stop and save pen diagnostics",
    icon: "save",
    checkCallback: (checking) => {
      if (!session.canStop) return false;
      if (!checking) void session.stop();
      return true;
    },
  });
  const dispose = (): void => {
    session.dispose();
    windows.clear();
  };
  plugin.register(dispose);
  return dispose;
}
