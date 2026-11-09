import { importDiagnosticText } from "./import-diagnostic-text";
import { quantity } from "./import-quantity";
import type { Localization } from "../../../domain/localization";
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
    heading: context.localization.t("import.entryHeading"),
    summary: context.localization.t("import.entrySummary"),
  });
  renderImportExamples(container, context);
  renderImportIntroduction(container, context.localization);
  renderNotice(container, {
    title: context.localization.t("import.controlTitle"),
    text: context.localization.t("import.controlDescription"),
    tone: "neutral",
  });
}

export function renderImportPreview(
  container: HTMLElement,
  preview: InkImportPreview,
  context: ImportViewContext,
  selectionChanged: (count: number) => void = () => undefined,
): () => InkImportPreview {
  renderImportStep(container, 2, context.localization);
  const summary = renderSummary(container, {
    heading: context.localization.t("import.found", {
      files: quantity(preview.sources.length, "handwriting", context.localization),
    }),
    summary: "",
  });
  const updateSummary = (count: number, notes: number): void => {
    summary.textContent = context.localization.t("import.selected", {
      count: context.localization.number(count),
      total: context.localization.number(preview.sources.length),
      notes: quantity(notes, "affectedNote", context.localization),
    });
    selectionChanged(count);
  };
  const selection = createImportSelection(preview, context, updateSummary);
  summary.textContent = context.localization.t("import.selected", {
    count: context.localization.number(selection.selectedCount),
    total: context.localization.number(preview.sources.length),
    notes: quantity(selection.noteCount, "affectedNote", context.localization),
  });
  summary.setAttribute("aria-live", "polite");
  container.createEl("p", {
    cls: "inkbook-import-guidance",
    text: context.localization.t("import.previewGuidance"),
  });
  if (preview.truncated) {
    renderNotice(container, {
      title: context.localization.t("import.scanLimit"),
      text: context.localization.t("import.scanLimitDescription"),
      tone: "caution",
    });
  }
  const storage = container.createEl("p", { cls: "inkbook-import-storage-note" });
  renderImportIcon(storage, "hard-drive", "inkbook-import-storage-icon");
  storage.createSpan({
    text: context.localization.t("import.storage"),
  });
  renderImportFindings(
    container,
    {
      id: "import.files",
      label: context.localization.t("import.files"),
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
    readonly localization: Localization;
    readonly selectedId?: string | undefined;
    readonly state?: { page?: number };
  },
): void {
  const context = options;
  if (history.length === 0) {
    container.createEl("p", {
      text: context.localization.t("import.historyEmpty"),
      cls: "inkbook-import-summary",
    });
  }
  renderPagedItems(container, {
    label: context.localization.t("import.historySaved"),
    localization: context.localization,
    count: history.length,
    entry: (row, index) => {
      row.classList.add("inkbook-import-history-item");
      const journal = history[index]!;
      const button = row.createEl("button", { cls: "inkbook-import-history-row" });
      button.type = "button";
      button.dataset.inkbookImportRun = journal.id;
      const text = button.createSpan({ cls: "inkbook-import-history-text" });
      text.createSpan({
        text:
          journal.unreadable === true
            ? context.localization.t("import.recordUnavailable")
            : formatImportDate(journal, context.localization),
        cls: "inkbook-import-history-date",
      });
      text.createSpan({
        text:
          journal.unreadable === true
            ? journal.id
            : `${importStatusLabel(journal.status, context.localization)} · ${quantity(journal.sources.length, "file", context.localization)}`,
        cls: "inkbook-import-history-meta",
      });
      const icon = button.createSpan({ cls: "inkbook-import-history-chevron" });
      icon.setAttribute("aria-hidden", "true");
      setIcon(icon, "chevron-right");
      button.addEventListener("click", () => select(journal));
    },
    mutate: options.mutate,
    ...(options.state === undefined ? {} : { state: options.state }),
    initialItem: history.findIndex((journal) => journal.id === options.selectedId),
  });
}

export function renderImportJournal(
  container: HTMLElement,
  journal: InkImportJournal,
  context: ImportViewContext,
): void {
  renderSummary(container, {
    heading:
      journal.unreadable === true
        ? context.localization.t("import.recordUnavailable")
        : formatImportDate(journal, context.localization),
    summary:
      journal.unreadable === true
        ? journal.id
        : `${importStatusLabel(journal.status, context.localization)} · ${quantity(journal.sources.length, "handwriting", context.localization)} · ${quantity(journal.notes.length, "note", context.localization)}`,
  });
  renderNotice(container, {
    title:
      journal.unreadable === true
        ? context.localization.t("import.keepRecovery")
        : context.localization.t("import.recoveryKept"),
    text:
      journal.unreadable === true
        ? context.localization.t("import.recordUnavailableDescription")
        : context.localization.t("import.recoveryFolder"),
    tone: journal.unreadable === true ? "caution" : "neutral",
  });
  renderJournalIssues(container, journal, context);
}

export function formatImportDate(journal: InkImportJournal, localization: Localization): string {
  const date = new Date(journal.createdAt);
  if (!Number.isFinite(date.getTime())) return localization.t("import.undated");
  return localization.date(date, { dateStyle: "medium", timeStyle: "short" });
}

export function importStatusLabel(
  status: InkImportJournal["status"],
  localization: Localization,
): string {
  const labels: Record<InkImportJournal["status"], string> = {
    running: localization.t("import.statusRunning"),
    complete: localization.t("import.statusComplete"),
    cancelled: localization.t("import.statusCancelled"),
    undone: localization.t("import.statusUndone"),
    conflict: localization.t("import.statusConflict"),
  };
  return labels[status];
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
      id: "import.issues",
      label: context.localization.t("import.issues"),
      count: journal.issues.length,
      icon: "triangle-alert",
      entry: (row, index) =>
        renderImportFinding(
          row,
          importDiagnosticText(
            context.localization,
            journal.issues[index]!,
            journal.issueDetails?.[index],
          ),
          paths,
        ),
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
