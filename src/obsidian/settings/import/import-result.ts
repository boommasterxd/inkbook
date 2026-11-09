import { importDiagnosticText } from "./import-diagnostic-text";
import { quantity } from "./import-quantity";
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
  const presentation = resultPresentation(result, operation, context);
  const hero = container.createDiv({ cls: "inkbook-import-result" });
  hero.dataset.result = presentation.state;
  if (operation === "import") renderImportStep(hero, 3, context.localization);
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
      id: "import.issues",
      label: context.localization.t("import.issues"),
      count: result.journal.issues.length,
      icon: "triangle-alert",
      entry: (row, index) =>
        renderImportFinding(
          row,
          importDiagnosticText(
            context.localization,
            result.journal.issues[index]!,
            result.journal.issueDetails?.[index],
          ),
          paths,
        ),
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
      id: "import.notesToReview",
      label: context.localization.t("import.notesToReview"),
      count: notes.length,
      icon: "files",
      entry: (row, index) => row.createSpan({ text: notes[index]!.path }),
    },
    context,
  );
}

function resultPresentation(
  result: InkImportResult,
  operation: ImportOperation,
  context: ImportViewContext,
) {
  const expectedStatus = operation === "undo" ? "undone" : "complete";
  const state: ResultState = result.cancelled
    ? "stopped"
    : result.conflicts > 0 ||
        result.journal.issues.length > 0 ||
        result.journal.status !== expectedStatus
      ? "review"
      : "success";
  if (operation === "undo") return undoPresentation(result, state, context);
  if (operation === "cleanup") return cleanupPresentation(result, state, context);
  return importPresentation(result, state, context);
}

function undoPresentation(result: InkImportResult, state: ResultState, context: ImportViewContext) {
  const conflicts = quantity(result.conflicts, "conflict", context.localization);
  const restored = result.journal.notes.filter((note) => note.status === "undone").length;
  return {
    state,
    heading:
      state === "stopped"
        ? context.localization.t("import.undoStopped")
        : state === "success"
          ? context.localization.t("import.undoSuccess")
          : context.localization.t("import.undoReview"),
    summary: context.localization.t("import.undoSummary", {
      notes: quantity(restored, "note", context.localization),
      conflicts,
    }),
    description: context.localization.t("import.undoResultDescription"),
    nextTitle:
      state === "success"
        ? context.localization.t("import.undoNextTitle")
        : context.localization.t("import.undoReviewTitle"),
    next:
      state === "success"
        ? context.localization.t("import.undoNext")
        : context.localization.t("import.undoReviewNext"),
    recovery: context.localization.t("import.undoRecovery"),
  };
}

function cleanupPresentation(
  result: InkImportResult,
  state: ResultState,
  context: ImportViewContext,
) {
  const conflicts = quantity(result.conflicts, "conflict", context.localization);
  const cleaned = result.journal.sources.filter((source) => source.status === "cleaned").length;
  const remaining = result.journal.sources.length - cleaned;
  return {
    state,
    heading:
      state === "stopped"
        ? context.localization.t("import.cleanupStopped")
        : state === "success"
          ? context.localization.t("import.cleanupSuccess")
          : context.localization.t("import.cleanupReview"),
    summary: context.localization.t("import.cleanupSummary", {
      cleaned: quantity(cleaned, "original", context.localization),
      remaining: quantity(remaining, "original", context.localization),
      conflicts,
    }),
    description: context.localization.t("import.cleanupResultDescription"),
    nextTitle:
      remaining > 0
        ? context.localization.t("import.cleanupRemaining")
        : context.localization.t("import.cleanupReady"),
    next:
      remaining > 0
        ? context.localization.t("import.cleanupNextRemaining")
        : context.localization.t("import.cleanupNext"),
    recovery: context.localization.t("import.cleanupRecovery"),
  };
}

function importPresentation(
  result: InkImportResult,
  state: ResultState,
  context: ImportViewContext,
) {
  const conflicts = quantity(result.conflicts, "conflict", context.localization);
  return {
    state,
    heading:
      state === "stopped"
        ? context.localization.t("import.importStopped")
        : state === "success"
          ? context.localization.t("import.statusComplete")
          : context.localization.t("import.importReview"),
    summary: context.localization.t("import.importSummary", {
      files: quantity(result.imported, "handwriting", context.localization),
      conflicts,
    }),
    description:
      state === "success"
        ? context.localization.t("import.importSuccessDescription")
        : context.localization.t("import.importReviewDescription"),
    nextTitle:
      state === "success"
        ? context.localization.t("import.importNextTitle")
        : context.localization.t("import.importReviewTitle"),
    next:
      state === "success"
        ? context.localization.t("import.importNext")
        : context.localization.t("import.importReviewNext"),
    recovery: context.localization.t("import.importRecovery"),
  };
}
