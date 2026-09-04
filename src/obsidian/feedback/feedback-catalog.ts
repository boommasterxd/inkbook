export type InkbookFeedbackCode =
  | "changes-save-failed"
  | "clipboard-copy-fallback"
  | "clipboard-copy-failed"
  | "clipboard-operation-busy"
  | "clipboard-paste-failed"
  | "clipboard-paste-invalid"
  | "clipboard-paste-read-failed"
  | "clipboard-paste-stale"
  | "cut-selection-changed"
  | "drawing-load-failed"
  | "drawing-version-changed"
  | "editor-activation-delayed"
  | "editor-start-failed"
  | "embed-copy-clipboard-unavailable"
  | "embed-copy-failed"
  | "embed-delete-failed"
  | "embed-delete-file-kept"
  | "embed-delete-note-changed"
  | "embed-delete-references-unavailable"
  | "embed-paste-cleanup-failed"
  | "embed-paste-failed"
  | "embed-paste-note-changed"
  | "handwriting-inserted"
  | "history-change-failed"
  | "history-lock-required"
  | "insertion-cleanup-failed"
  | "insertion-failed"
  | "insertion-note-changed-cleaned"
  | "insertion-undo-edit-failed"
  | "insertion-undo-file-kept"
  | "insertion-undo-note-changed"
  | "placement-folder-fallback"
  | "recovery-copy-saved";

export type InkbookFeedbackSeverity = "error" | "info" | "success" | "warning";

export interface InkbookFeedbackContent {
  readonly detail?: string;
  readonly severity: InkbookFeedbackSeverity;
  readonly title: string;
}

const FEEDBACK: Readonly<Record<InkbookFeedbackCode, InkbookFeedbackContent>> = {
  "changes-save-failed": {
    detail: "Your changes are still available in the editor.",
    severity: "error",
    title: "Changes couldn't be saved.",
  },
  "clipboard-copy-fallback": {
    detail: "You can still paste the elements in this Inkbook editor.",
    severity: "warning",
    title: "The system clipboard isn't available.",
  },
  "clipboard-copy-failed": {
    detail: "The selection is unchanged.",
    severity: "error",
    title: "The elements couldn't be copied.",
  },
  "clipboard-operation-busy": {
    detail: "Wait a moment and try again.",
    severity: "warning",
    title: "Another clipboard action is still running.",
  },
  "clipboard-paste-failed": {
    detail: "Nothing was changed. Try again.",
    severity: "error",
    title: "The elements couldn't be pasted.",
  },
  "clipboard-paste-invalid": {
    detail: "Copy Inkbook elements and try again.",
    severity: "info",
    title: "The clipboard doesn't contain Inkbook elements.",
  },
  "clipboard-paste-read-failed": {
    detail: "Check the clipboard permission and try again.",
    severity: "error",
    title: "The clipboard couldn't be read.",
  },
  "clipboard-paste-stale": {
    detail: "Nothing was pasted. Try again.",
    severity: "warning",
    title: "Paste stopped because the drawing changed.",
  },
  "cut-selection-changed": {
    detail: "The copied elements are still available.",
    severity: "warning",
    title: "Cut stopped because the selection changed.",
  },
  "drawing-load-failed": {
    detail: "The saved preview is still available.",
    severity: "error",
    title: "The drawing couldn't be opened.",
  },
  "drawing-version-changed": {
    detail: "The saved preview was refreshed. Review it before trying again.",
    severity: "warning",
    title: "The drawing changed before it opened.",
  },
  "editor-activation-delayed": {
    detail: "The drawing was inserted. Try opening the editor again.",
    severity: "warning",
    title: "The editor isn't ready yet.",
  },
  "editor-start-failed": {
    detail:
      "The preview is still available. Update Obsidian or check its security settings, then retry.",
    severity: "error",
    title: "The editor couldn't start.",
  },
  "embed-copy-clipboard-unavailable": {
    detail: "Allow clipboard access and try again.",
    severity: "error",
    title: "The embed couldn't be copied.",
  },
  "embed-copy-failed": {
    detail: "The embed and drawing file are unchanged.",
    severity: "error",
    title: "The embed couldn't be copied.",
  },
  "embed-delete-failed": {
    detail: "The drawing file was preserved.",
    severity: "error",
    title: "The embed couldn't be deleted.",
  },
  "embed-delete-file-kept": {
    detail: "You can remove the file manually if it is no longer needed.",
    severity: "warning",
    title: "The embed was removed, but its drawing file was kept.",
  },
  "embed-delete-note-changed": {
    detail: "The drawing file was preserved. Try again after the note stops changing.",
    severity: "warning",
    title: "Delete stopped because the note changed.",
  },
  "embed-delete-references-unavailable": {
    detail: "Nothing was deleted because other references couldn't be checked safely.",
    severity: "warning",
    title: "The embed couldn't be deleted safely.",
  },
  "embed-paste-cleanup-failed": {
    detail: "A duplicate drawing file may need to be removed manually.",
    severity: "error",
    title: "Paste stopped because the note changed.",
  },
  "embed-paste-failed": {
    detail: "The note was left unchanged. Try again.",
    severity: "error",
    title: "The drawing embed couldn't be pasted.",
  },
  "embed-paste-note-changed": {
    detail: "Nothing was pasted. Try again after the note stops changing.",
    severity: "warning",
    title: "Paste stopped because the note changed.",
  },
  "handwriting-inserted": {
    severity: "success",
    title: "Handwriting inserted.",
  },
  "history-change-failed": {
    detail: "The drawing is unchanged. Try again.",
    severity: "error",
    title: "The history change couldn't be applied.",
  },
  "history-lock-required": {
    severity: "info",
    title: "Lock the drawing to continue undoing note changes.",
  },
  "insertion-cleanup-failed": {
    detail: "A created drawing file may need to be removed manually.",
    severity: "error",
    title: "The handwriting embed couldn't be inserted.",
  },
  "insertion-failed": {
    detail: "The note was left unchanged. Try again.",
    severity: "error",
    title: "The handwriting embed couldn't be inserted.",
  },
  "insertion-note-changed-cleaned": {
    detail: "The unused drawing file was moved to trash.",
    severity: "warning",
    title: "Insertion stopped because the note changed.",
  },
  "insertion-undo-edit-failed": {
    detail: "The embed and drawing file were preserved.",
    severity: "error",
    title: "The insertion couldn't be undone.",
  },
  "insertion-undo-file-kept": {
    detail: "The embed was removed. Its drawing file can be removed manually.",
    severity: "warning",
    title: "The drawing file couldn't be moved to trash.",
  },
  "insertion-undo-note-changed": {
    detail: "The embed and drawing file were preserved.",
    severity: "warning",
    title: "Undo stopped because the note changed.",
  },
  "placement-folder-fallback": {
    detail: "The drawing was saved beside this note instead.",
    severity: "warning",
    title: "The selected folder isn't available.",
  },
  "recovery-copy-saved": {
    severity: "success",
    title: "Recovery copy saved.",
  },
};

export function feedbackContent(code: InkbookFeedbackCode): InkbookFeedbackContent {
  return FEEDBACK[code];
}
