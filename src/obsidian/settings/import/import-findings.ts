import { setIcon } from "obsidian";
import { isReducedMotion, type MotionPreference } from "../../../rendering/motion/transitions";
import type { ObserveMotion } from "../../runtime/effective-motion";
import { createSettingsDisclosure } from "../settings-disclosure";
import { SettingsPanelMotion } from "../settings-panel-motion";
import { renderPagedItems } from "./paged-findings";

export interface ImportViewContext {
  readonly mutate: (update: () => void) => void;
  readonly readMotion: () => MotionPreference;
  readonly observeMotion?: ObserveMotion;
  readonly own: (dispose: () => void) => void;
}

export function renderImportIcon(container: HTMLElement, icon: string, cls: string): HTMLElement {
  const element = container.createSpan({ cls });
  element.setAttribute("aria-hidden", "true");
  setIcon(element, icon);
  return element;
}

export function renderImportFile(
  row: HTMLElement,
  source: { readonly path: string; readonly targetPath: string },
  selection: { readonly selected: boolean; readonly change: (selected: boolean) => void },
): void {
  row.classList.add("inkbook-import-file-row");
  const label = row.createEl("label", { cls: "inkbook-import-file-choice" });
  const input = label.createEl("input");
  input.type = "checkbox";
  input.checked = selection.selected;
  input.dataset.inkbookImportSource = source.path;
  input.setAttribute("aria-label", `Import ${source.path}`);
  input.addEventListener("change", () => selection.change(input.checked));
  const copy = label.createDiv({ cls: "inkbook-import-file-copy" });
  copy.createEl("strong", {
    text: source.path.slice(source.path.lastIndexOf("/") + 1),
    cls: "inkbook-import-file-name",
  });
  copy.createSpan({ text: source.path, cls: "inkbook-import-file-path" });
  const target = copy.createDiv({ cls: "inkbook-import-file-target" });
  target.createSpan({ text: "Inkbook copy", cls: "inkbook-import-file-target-label" });
  target.createSpan({ text: source.targetPath, cls: "inkbook-import-file-path" });
}

export function renderImportFinding(
  row: HTMLElement,
  message: string,
  paths: readonly string[],
  presentation: { readonly icon: string; readonly tone: "caution" | "neutral" } = {
    icon: "triangle-alert",
    tone: "caution",
  },
): HTMLElement {
  row.classList.add("inkbook-import-finding-row");
  row.dataset.tone = presentation.tone;
  renderImportIcon(row, presentation.icon, "inkbook-import-file-icon");
  const copy = row.createDiv({ cls: "inkbook-import-finding-copy" });
  const source = paths.find((path) => message.startsWith(`${path}: `));
  copy.createSpan({
    text: source === undefined ? message : message.slice(source.length + 2),
    cls: "inkbook-import-finding-message",
  });
  if (source !== undefined) {
    copy.createSpan({ text: source, cls: "inkbook-import-finding-source" });
  }
  return copy;
}

export function renderImportFindings(
  container: HTMLElement,
  options: {
    readonly label: string;
    readonly count: number;
    readonly icon: string;
    readonly entry: (row: HTMLElement, index: number, pageContext: ImportViewContext) => void;
    readonly before?: (container: HTMLElement) => void;
  },
  context: ImportViewContext,
): void {
  const { label, count, icon, entry } = options;
  if (count === 0) return;
  const disclosure = createSettingsDisclosure(container, {
    title: `${label} (${count})`,
    description: `Review ${label.toLowerCase()}.`,
    expanded: false,
    panelId: `inkbook-import-${container.ownerDocument.defaultView!.crypto.randomUUID()}`,
    sectionClass: "inkbook-import-disclosure",
    contentClass: "inkbook-import-disclosure-content",
    triggerClass: "inkbook-import-disclosure-trigger",
    readMotion: context.readMotion,
    ...(context.observeMotion === undefined ? {} : { observeMotion: context.observeMotion }),
  });
  const leading = renderImportIcon(disclosure.trigger, icon, "inkbook-import-disclosure-icon");
  disclosure.trigger.dataset.tone = icon === "triangle-alert" ? "caution" : "neutral";
  disclosure.trigger.prepend(leading);
  disclosure.content.replaceChildren();
  const panelMotion = new SettingsPanelMotion(
    disclosure.panel,
    context.readMotion,
    context.observeMotion,
  );
  let populated = false;
  const pageDisposers: Array<() => void> = [];
  const pageContext: ImportViewContext = {
    ...context,
    own: (dispose) => pageDisposers.push(dispose),
  };
  const releasePage = (): void => {
    for (const dispose of pageDisposers.splice(0)) dispose();
  };
  const toggle = (): void => {
    const expanded = disclosure.trigger.getAttribute("aria-expanded") !== "true";
    context.mutate(() => {
      if (expanded && !populated) {
        options.before?.(disclosure.content);
        renderPagedItems(disclosure.content, {
          label,
          count,
          entry: (row, index) => entry(row, index, pageContext),
          releasePage,
          mutate: context.mutate,
        });
        populated = true;
      }
      disclosure.trigger.setAttribute("aria-expanded", String(expanded));
      panelMotion.setExpanded(expanded);
      disclosure.setExpanded(
        expanded,
        isReducedMotion(
          context.readMotion(),
          container.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches,
        ),
      );
    });
  };
  disclosure.trigger.addEventListener("click", toggle);
  context.own(() => {
    releasePage();
    disclosure.trigger.removeEventListener("click", toggle);
    disclosure.dispose();
    panelMotion.dispose();
  });
}
