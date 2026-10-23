import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { setIcon } from "obsidian";

import type { DocumentSaveStatus } from "../../editor/session/session-port";
import { isReducedMotion, type MotionPreference } from "../../rendering/motion/transitions";
import { DocumentStatusBarContent } from "../../rendering/ui/document-status-bar-content";
import type { WorkspaceDocumentSaveStatusSource } from "../embeds/workspace/workspace-document-status";

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

function renderIcon(element: HTMLElement, name: string, viewBox: string): void {
  setIcon(element, name);
  const svg = element.querySelector("svg");
  svg?.setAttribute("viewBox", viewBox);
  svg?.removeAttribute("width");
  svg?.removeAttribute("height");
}

/** Mounts one native status item and owns its React/Motion content lifetime. */
export function mountDocumentStatusBar(
  container: HTMLElement,
  source: WorkspaceDocumentSaveStatusSource,
  readPreference: () => MotionPreference = () => "system",
): { dispose: () => void; refreshColors: () => void; refreshMotion: () => void } {
  const ownerWindow = container.ownerDocument.defaultView;
  const query = ownerWindow?.matchMedia?.("(prefers-reduced-motion: reduce)");
  const view = createRoot(container);
  let disposed = false;
  let root: HTMLElement | null = null;
  let renderedStatus = "";
  let renderedLabel = "";
  let renderedMotion: MotionPreference | undefined;
  let renderedReduced: boolean | undefined;
  let renderedTitle = "";
  let paletteRevision = 0;
  let renderedPaletteRevision = -1;
  const update = (): void => {
    if (disposed) return;
    const current = source.current();
    const status = current?.status ?? "inactive";
    const label = current === null ? "No Inkbook embed open" : LABELS[current.status];
    const title = current === null ? label : `Inkbook: ${label}\n${current.path}`;
    const motionPreference = readPreference();
    const reduced = isReducedMotion(motionPreference, query?.matches ?? false);
    if (
      root !== null &&
      status === renderedStatus &&
      label === renderedLabel &&
      motionPreference === renderedMotion &&
      reduced === renderedReduced &&
      paletteRevision === renderedPaletteRevision
    ) {
      if (title !== renderedTitle) root.title = title;
    } else {
      flushSync(() =>
        view.render(
          createElement(DocumentStatusBarContent, {
            icon: current === null ? null : ICONS[current.status],
            label,
            motionPreference,
            paletteRevision,
            reduced,
            renderIcon,
            status,
            title,
          }),
        ),
      );
      root = container.querySelector(".inkbook-status-bar");
      renderedStatus = status;
      renderedLabel = label;
      renderedMotion = motionPreference;
      renderedReduced = reduced;
      renderedPaletteRevision = paletteRevision;
    }
    renderedTitle = title;
  };
  query?.addEventListener("change", update);
  const unsubscribe = source.subscribe(update);
  update();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    query?.removeEventListener("change", update);
    unsubscribe();
    view.unmount();
  };
  return {
    dispose,
    refreshColors: () => {
      if (disposed) return;
      paletteRevision += 1;
      update();
    },
    refreshMotion: update,
  };
}
