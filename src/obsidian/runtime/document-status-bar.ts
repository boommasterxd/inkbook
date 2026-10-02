import { setIcon } from "obsidian";

import type { DocumentSaveStatus } from "../../editor/session/session-port";
import type { MotionPreference } from "../../rendering/motion/transitions";
import type { WorkspaceDocumentSaveStatusSource } from "../embeds/workspace-document-status";
import { DocumentStatusBarMotion } from "./document-status-bar-motion";

const LABELS: Readonly<Record<DocumentSaveStatus, string>> = {
  saved: "Saved",
  pending: "Unsaved changes",
  saving: "Saving…",
  failed: "Save failed",
};

// Tight glyph bounds include the native two-unit stroke and rounded caps.
const ICONS: Readonly<Record<DocumentSaveStatus, { name: string; viewBox: string }>> = {
  saved: { name: "check", viewBox: "3 5 18 13" },
  pending: { name: "pencil", viewBox: "1 1 22 22" },
  saving: { name: "loader-circle", viewBox: "2 2 20 20" },
  failed: { name: "circle-alert", viewBox: "1 1 22 22" },
};

/** Mounts one native status item and owns its content and motion lifetime. */
export function mountDocumentStatusBar(
  container: HTMLElement,
  source: WorkspaceDocumentSaveStatusSource,
  readPreference: () => MotionPreference = () => "system",
): { dispose: () => void; refreshMotion: () => void } {
  const root = container.createSpan({ cls: "inkbook-status-bar" });
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "Inkbook save status");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-atomic", "true");
  const content = root.createSpan({ cls: "inkbook-status-bar-content" });
  const icon = content.createSpan({ cls: "inkbook-status-bar-icon" });
  icon.setAttribute("aria-hidden", "true");
  const label = content.createSpan({ cls: "inkbook-status-bar-label" });
  const widthMotion = new DocumentStatusBarMotion(root, content, readPreference);
  let disposed = false;
  let previousIcon: (typeof ICONS)[DocumentSaveStatus] | null = null;
  const refreshMotion = (): void => {
    if (disposed) return;
    const motion = readPreference();
    if (root.dataset.inkbookMotion !== motion) root.dataset.inkbookMotion = motion;
    widthMotion.refreshMotion();
  };
  const update = (): void => {
    if (disposed) return;
    refreshMotion();
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
    else {
      setIcon(icon, nextIcon.name);
      const svg = icon.querySelector("svg");
      svg?.setAttribute("viewBox", nextIcon.viewBox);
      svg?.removeAttribute("width");
      svg?.removeAttribute("height");
    }
  };
  icon.hidden = true;
  const unsubscribe = source.subscribe(update);
  update();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    widthMotion.dispose();
    unsubscribe();
    root.remove();
  };
  return { dispose, refreshMotion };
}
