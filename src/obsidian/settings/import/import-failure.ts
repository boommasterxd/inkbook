import type { Localization } from "../../../domain/localization";
import { InkImportNoteBackupError } from "../../import/note-backup-error";
import type { PendingImportOperation } from "./import-status";

/** Render only controlled recovery details; unknown errors stay private. */
export function renderImportFailure(
  container: HTMLElement,
  cancelled: boolean,
  operation: PendingImportOperation,
  error: unknown,
  localization: Localization,
): string {
  if (
    !cancelled &&
    (operation === "undo" || operation === "cleanup") &&
    error instanceof InkImportNoteBackupError
  ) {
    const heading =
      error.reason === "unavailable"
        ? localization.t("import.backupUnavailable")
        : localization.t("import.backupChanged");
    container.createEl("h3", { text: heading });
    container.createEl("p", {
      text:
        error.reason === "unavailable"
          ? localization.t("import.backupUnavailableDescription")
          : localization.t("import.backupChangedDescription"),
    });
    container.createEl("p", { text: localization.t("import.notePath", { path: error.notePath }) });
    container.createEl("p", {
      text: localization.t("import.backupPath", { path: error.backupPath }),
    });
    container.createEl("p", {
      text: localization.t("import.backupGuidance"),
    });
    return heading;
  }
  container.createEl("h3", {
    text: cancelled
      ? localization.t("import.operationStopped")
      : localization.t("import.operationFailure"),
  });
  container.createEl("p", {
    text:
      operation === "scan"
        ? localization.t("import.scanFailureGuidance")
        : localization.t("import.operationFailureGuidance"),
  });
  if (!cancelled) return localization.t("import.operationFailureStatus");
  return operation === "scan"
    ? localization.t("import.scanStoppedStatus")
    : localization.t("import.operationStoppedStatus");
}
