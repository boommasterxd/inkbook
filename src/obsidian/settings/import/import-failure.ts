import { InkImportNoteBackupError } from "../../import/note-backup-error";
import type { PendingImportOperation } from "./import-status";

/** Render only controlled recovery details; unknown errors stay private. */
export function renderImportFailure(
  container: HTMLElement,
  cancelled: boolean,
  operation: PendingImportOperation,
  error: unknown,
): string {
  if (
    !cancelled &&
    (operation === "undo" || operation === "cleanup") &&
    error instanceof InkImportNoteBackupError
  ) {
    const heading =
      error.reason === "unavailable" ? "Recovery backup unavailable" : "Recovery backup changed";
    container.createEl("h3", { text: heading });
    container.createEl("p", {
      text:
        error.reason === "unavailable"
          ? "The original note backup is missing or could not be read. Recovery stopped before undo or cleanup."
          : "The original note backup does not match this import's recorded content. Recovery stopped before undo or cleanup.",
    });
    container.createEl("p", { text: `Note: ${error.notePath}` });
    container.createEl("p", { text: `Recovery backup: ${error.backupPath}` });
    container.createEl("p", {
      text: "Keep the import history and recovery files. Restore the exact original backup at this path from a trusted vault backup or sync history, then retry from import history. Do not replace it with the current note or edit the import record to bypass this check.",
    });
    return heading;
  }
  container.createEl("h3", {
    text: cancelled ? "Operation stopped" : "The operation could not finish",
  });
  container.createEl("p", {
    text:
      operation === "scan"
        ? "Your files are unchanged. Go back to scan again, or close this window and try later."
        : "Some changes may already be complete. Go to Settings → Inkbook → Import → Import history to review or undo this run before retrying.",
  });
  if (!cancelled) return "The operation could not finish.";
  return operation === "scan"
    ? "Stopped. Your files are unchanged."
    : "Stopped. Check import history for completed changes.";
}
