import type { InkImportResult } from "../../import/types";
import { renderImportCompletion } from "./import-completion-illustration";
import {
  renderImportFinding,
  renderImportFindings,
  renderImportIcon,
  type ImportViewContext,
} from "./import-findings";
import { renderImportStep } from "./import-journey";

export type ImportOperation = "import" | "undo" | "cleanup";
type ResultState = "success" | "review" | "stopped";

/** Presents durable outcomes separately from the user's next step and recovery. */
export function renderImportResult(
  container: HTMLElement,
  result: InkImportResult,
  context: ImportViewContext,
  operation: ImportOperation = "import",
): void {
  const presentation = resultPresentation(result, operation);
  const hero = container.createDiv({ cls: "inkbook-import-result" });
  hero.dataset.result = presentation.state;
  if (operation === "import") renderImportStep(hero, 3);
  if (presentation.state === "success") renderImportCompletion(hero, context);
  else renderImportIcon(hero, "triangle-alert", "inkbook-import-result-attention");
  hero.createEl("h3", { text: presentation.heading, cls: "inkbook-import-heading" });
  hero.createEl("p", { text: presentation.summary, cls: "inkbook-import-result-count" });
  hero.createEl("p", { text: presentation.description, cls: "inkbook-import-result-description" });
  const next = container.createEl("section", { cls: "inkbook-import-next-step" });
  next.createEl("h4", { text: presentation.nextTitle });
  next.createEl("p", { text: presentation.next });
  renderResultNotes(next, result, context, operation);
  const recovery = container.createDiv({ cls: "inkbook-import-result-recovery" });
  renderImportIcon(recovery, "undo-2", "inkbook-import-file-icon");
  recovery.createEl("p", { text: presentation.recovery });
  const paths = [
    ...result.journal.sources.map((source) => source.path),
    ...result.journal.notes.map((note) => note.path),
  ];
  renderImportFindings(
    container,
    {
      label: "Issues",
      count: result.journal.issues.length,
      icon: "triangle-alert",
      entry: (row, index) => renderImportFinding(row, result.journal.issues[index]!, paths),
    },
    context,
  );
}

function renderResultNotes(
  container: HTMLElement,
  result: InkImportResult,
  context: ImportViewContext,
  operation: ImportOperation,
): void {
  if (operation !== "import") return;
  const notes = result.journal.notes.filter((note) => note.status === "applied");
  renderImportFindings(
    container,
    {
      label: "Notes to review",
      count: notes.length,
      icon: "files",
      entry: (row, index) => row.createSpan({ text: notes[index]!.path }),
    },
    context,
  );
}

function resultPresentation(result: InkImportResult, operation: ImportOperation) {
  const expectedStatus = operation === "undo" ? "undone" : "complete";
  const state: ResultState = result.cancelled
    ? "stopped"
    : result.conflicts > 0 ||
        result.journal.issues.length > 0 ||
        result.journal.status !== expectedStatus
      ? "review"
      : "success";
  if (operation === "undo") return undoPresentation(result, state);
  if (operation === "cleanup") return cleanupPresentation(result, state);
  return importPresentation(result, state);
}

function undoPresentation(result: InkImportResult, state: ResultState) {
  const conflicts = `${quantity(result.conflicts, "conflict")}.`;
  const restored = result.journal.notes.filter((note) => note.status === "undone").length;
  return {
    state,
    heading:
      state === "stopped"
        ? "Restore stopped"
        : state === "success"
          ? "Obsidian Ink embeds restored"
          : "Restore needs review",
    summary: `${quantity(restored, "note")} restored; ${conflicts}`,
    description: "Restored notes use their original Obsidian Ink files again.",
    nextTitle: state === "success" ? "Your original embeds are back" : "Check this restore",
    next:
      state === "success"
        ? "Close the settings and open a restored note. Original SVGs keep their own appearance, including their colors in dark mode."
        : "Review this import record and any issues before retrying. Notes with conflicts need your attention.",
    recovery: "Your Inkbook copies and later edits are kept. Recovery backups remain in the vault.",
  };
}

function cleanupPresentation(result: InkImportResult, state: ResultState) {
  const conflicts = `${quantity(result.conflicts, "conflict")}.`;
  const cleaned = result.journal.sources.filter((source) => source.status === "cleaned").length;
  const remaining = result.journal.sources.length - cleaned;
  return {
    state,
    heading:
      state === "stopped"
        ? "Cleanup stopped"
        : state === "success"
          ? "Original files checked"
          : "Cleanup needs review",
    summary: `${quantity(cleaned, "original")} cleaned up; ${quantity(remaining, "original")} remaining; ${conflicts}`,
    description: "Only verified, unchanged originals without references are moved to trash.",
    nextTitle: remaining > 0 ? "Some originals remain" : "Your Inkbook notes are ready",
    next:
      remaining > 0
        ? "Files still in use or changed since import stay in place. Review this record before attempting further cleanup."
        : "Continue using your Inkbook notes. Your converted handwriting stays editable.",
    recovery:
      "Inkbook files and recovery backups are kept. Backup storage is not freed by this cleanup.",
  };
}

function importPresentation(result: InkImportResult, state: ResultState) {
  const conflicts = `${quantity(result.conflicts, "conflict")}.`;
  return {
    state,
    heading:
      state === "stopped"
        ? "Import stopped"
        : state === "success"
          ? "Import complete"
          : "Import needs review",
    summary: `${quantity(result.imported, "handwriting file")}; ${conflicts}`,
    description:
      state === "success"
        ? "Your notes now use editable Inkbook copies."
        : "Completed changes are saved in this import record.",
    nextTitle: state === "success" ? "Next: check your handwriting" : "Review before continuing",
    next:
      state === "success"
        ? "Close the settings and open one of the notes listed here. Check its handwriting before removing any originals."
        : "Open View import and review any issues. Check notes that were updated before retrying or restoring the original embeds.",
    recovery:
      "Originals and recovery backups are kept. To go back, use Settings → Inkbook → Import → Import history.",
  };
}

function quantity(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
