import { setIcon } from "obsidian";

import type { DocumentSaveStatus } from "../../editor/session/session-port";
import type { MotionPreference } from "../../rendering/motion/transitions";
import type { WorkspaceDocumentSaveStatusSource } from "../embeds/workspace-document-status";

const LABELS: Readonly<Record<DocumentSaveStatus, string>> = {
  saved: "Saved",
  pending: "Unsaved changes",
  saving: "Saving…",
  failed: "Save failed",
};

const ICONS: Readonly<Record<DocumentSaveStatus, string | null>> = {
  saved: "check",
  pending: null,
  saving: "loader-circle",
  failed: "circle-alert",
};

/** Mounts one native status item; its owner releases it through the returned disposer. */
export function mountDocumentStatusBar(
  container: HTMLElement,
  source: WorkspaceDocumentSaveStatusSource,
  readPreference: () => MotionPreference = () => "system",
): () => void {
  const root = container.createSpan({ cls: "inkbook-status-bar" });
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "Inkbook save status");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-atomic", "true");
  const icon = root.createSpan({ cls: "inkbook-status-bar-icon" });
  icon.setAttribute("aria-hidden", "true");
  const label = root.createSpan();
  let disposed = false;
  let previousIcon: string | null = null;
  const update = (): void => {
    if (disposed) return;
    const motion = readPreference();
    if (root.dataset.inkbookMotion !== motion) root.dataset.inkbookMotion = motion;
    const current = source.current();
    const status = current?.status ?? "inactive";
    if (root.dataset.saveStatus !== status) root.dataset.saveStatus = status;
    const text = current === null ? "No Inkbook embed open" : LABELS[current.status];
    if (label.textContent !== text) label.textContent = text;
    const title = current === null ? text : `Inkbook: ${text}\n${current.path}`;
    if (root.title !== title) root.title = title;
    const nextIcon = current === null ? null : ICONS[current.status];
    if (nextIcon === previousIcon) return;
    previousIcon = nextIcon;
    icon.hidden = nextIcon === null;
    if (nextIcon === null) icon.replaceChildren();
    else setIcon(icon, nextIcon);
  };
  icon.hidden = true;
  const unsubscribe = source.subscribe(update);
  update();
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    root.remove();
  };
}
