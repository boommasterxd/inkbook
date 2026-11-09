import { setIcon } from "obsidian";
import type { InkImportJournal, InkImportPreview } from "../../import/types";
import {
  renderImportFinding,
  renderImportFindings,
  renderImportIcon,
  type ImportViewContext,
} from "./import-findings";
import { renderPagedItems } from "./paged-findings";
import { renderImportIntroduction, renderImportStep } from "./import-journey";
import { createImportSelection } from "./import-selection";
import { buildImportPreviewFindings } from "./preview-findings";
import { renderPreviewFindings } from "./import-review-findings";
import { renderImportExamples } from "./import-examples";

export type { ImportViewContext } from "./import-findings";

export { renderImportResult, type ImportOperation } from "./import-result";

export function renderImportEntry(container: HTMLElement, context: ImportViewContext): void {
  renderSummary(container, {
    heading: "Import your handwriting",
    summary: "Keep your existing notes and edit their handwriting in Inkbook.",
  });
  renderImportExamples(container, context);
  renderImportIntroduction(container);
  renderNotice(container, {
    title: "You stay in control",
    text: "Original files are kept, drawing canvases stay untouched, and you can undo the import later.",
    tone: "neutral",
  });
}

export function renderImportPreview(
  container: HTMLElement,
  preview: InkImportPreview,
  context: ImportViewContext,
  selectionChanged: (count: number) => void = () => undefined,
): () => InkImportPreview {
  renderImportStep(container, 2);
  const summary = renderSummary(container, {
    heading: `${quantity(preview.sources.length, "handwriting file")} found`,
    summary: "",
  });
  const updateSummary = (count: number, notes: number): void => {
    summary.textContent = `${count} of ${preview.sources.length} selected · ${quantity(notes, "affected note")}`;
    selectionChanged(count);
  };
  const selection = createImportSelection(preview, context, updateSummary);
  summary.textContent = `${preview.sources.length} of ${preview.sources.length} selected · ${quantity(selection.noteCount, "affected note")}`;
  summary.setAttribute("aria-live", "polite");
  container.createEl("p", {
    cls: "inkbook-import-guidance",
    text: "Choose what to include in the file list below. Review any differences or warnings before importing.",
  });
  if (preview.truncated) {
    renderNotice(container, {
      title: "Scan limit reached",
      text: "Scan limit reached. Only the listed files will be imported; scan again afterward.",
      tone: "caution",
    });
  }
  const storage = container.createEl("p", { cls: "inkbook-import-storage-note" });
  renderImportIcon(storage, "hard-drive", "inkbook-import-storage-icon");
  storage.createSpan({
    text: "Local conversion · copies and recovery backups use extra vault and sync storage.",
  });
  renderImportFindings(
    container,
    {
      label: "Handwriting files",
      count: preview.sources.length,
      icon: "file-pen-line",
      before: selection.renderControls,
      entry: selection.renderFile,
    },
    context,
  );
  renderPreviewFindings(container, buildImportPreviewFindings(preview), context);
  return selection.snapshot;
}

export function renderImportHistory(
  container: HTMLElement,
  history: readonly InkImportJournal[],
  select: (journal: InkImportJournal) => void,
  options: {
    readonly mutate: (update: () => void) => void;
    readonly selectedId?: string | undefined;
  },
): void {
  if (history.length === 0) {
    container.createEl("p", { text: "No saved imports.", cls: "inkbook-import-summary" });
  }
  renderPagedItems(container, {
    label: "Saved imports",
    count: history.length,
    entry: (row, index) => {
      row.classList.add("inkbook-import-history-item");
      const journal = history[index]!;
      const button = row.createEl("button", { cls: "inkbook-import-history-row" });
      button.type = "button";
      button.dataset.inkbookImportRun = journal.id;
      const text = button.createSpan({ cls: "inkbook-import-history-text" });
      text.createSpan({
        text: journal.unreadable === true ? "Record unavailable" : formatImportDate(journal),
        cls: "inkbook-import-history-date",
      });
      text.createSpan({
        text:
          journal.unreadable === true
            ? journal.id
            : `${importStatusLabel(journal.status)} · ${quantity(journal.sources.length, "file")}`,
        cls: "inkbook-import-history-meta",
      });
      const icon = button.createSpan({ cls: "inkbook-import-history-chevron" });
      icon.setAttribute("aria-hidden", "true");
      setIcon(icon, "chevron-right");
      button.addEventListener("click", () => select(journal));
    },
    mutate: options.mutate,
    initialItem: history.findIndex((journal) => journal.id === options.selectedId),
  });
}

export function renderImportJournal(
  container: HTMLElement,
  journal: InkImportJournal,
  context: ImportViewContext,
): void {
  renderSummary(container, {
    heading: journal.unreadable === true ? "Record unavailable" : formatImportDate(journal),
    summary:
      journal.unreadable === true
        ? journal.id
        : `${importStatusLabel(journal.status)} · ${quantity(journal.sources.length, "handwriting file")} · ${quantity(journal.notes.length, "note")}`,
  });
  renderNotice(container, {
    title: journal.unreadable === true ? "Keep recovery files" : "Recovery files are kept",
    text:
      journal.unreadable === true
        ? "Record unavailable. Keep recovery files; undo and cleanup are unavailable."
        : "Recovery backups remain in inkbook-imports.",
    tone: journal.unreadable === true ? "caution" : "neutral",
  });
  renderJournalIssues(container, journal, context);
}

export function formatImportDate(journal: InkImportJournal): string {
  const date = new Date(journal.createdAt);
  if (!Number.isFinite(date.getTime())) return "Undated import";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

export function importStatusLabel(status: InkImportJournal["status"]): string {
  const labels: Record<InkImportJournal["status"], string> = {
    running: "In progress",
    complete: "Import complete",
    cancelled: "Stopped",
    undone: "Undone",
    conflict: "Needs review",
  };
  return labels[status];
}

function quantity(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function renderJournalIssues(
  container: HTMLElement,
  journal: InkImportJournal,
  context: ImportViewContext,
): void {
  const paths = [
    ...journal.sources.map((source) => source.path),
    ...journal.notes.map((note) => note.path),
  ];
  renderImportFindings(
    container,
    {
      label: "Issues",
      count: journal.issues.length,
      icon: "triangle-alert",
      entry: (row, index) => renderImportFinding(row, journal.issues[index]!, paths),
    },
    context,
  );
}

function renderSummary(
  container: HTMLElement,
  presentation: {
    readonly heading: string;
    readonly summary: string;
  },
): HTMLElement {
  const block = container.createDiv({ cls: "inkbook-import-summary-block" });
  const copy = block.createDiv({ cls: "inkbook-import-summary-copy" });
  copy.createEl("h3", { text: presentation.heading, cls: "inkbook-import-heading" });
  return copy.createEl("p", { text: presentation.summary, cls: "inkbook-import-summary" });
}

function renderNotice(
  container: HTMLElement,
  notice: {
    readonly title: string;
    readonly text: string;
    readonly tone: "neutral" | "caution";
  },
): void {
  const block = container.createDiv({ cls: "inkbook-import-notice" });
  block.dataset.tone = notice.tone;
  renderImportIcon(
    block,
    notice.tone === "neutral" ? "shield-check" : "triangle-alert",
    "inkbook-import-notice-icon",
  );
  const copy = block.createDiv({ cls: "inkbook-import-notice-copy" });
  copy.createEl("strong", { text: notice.title, cls: "inkbook-import-notice-title" });
  copy.createEl("p", {
    text: notice.text,
    cls: notice.tone === "neutral" ? "inkbook-import-safety" : "inkbook-import-warning",
  });
}
