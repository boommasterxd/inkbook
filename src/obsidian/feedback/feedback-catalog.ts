import { Localization, type Translator } from "../../domain/localization";
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
  | "embed-open-failed"
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
  | "onboarding-preference-failed"
  | "recovery-copy-saved"
  | "stroke-point-limit-reached";

export type InkbookFeedbackSeverity = "error" | "info" | "success" | "warning";

export interface InkbookFeedbackContent {
  readonly detail?: string;
  readonly severity: InkbookFeedbackSeverity;
  readonly title: string;
}

const FEEDBACK: Readonly<
  Record<
    InkbookFeedbackCode,
    {
      severity: InkbookFeedbackSeverity;
      title: Parameters<Translator>[0];
      detail?: Parameters<Translator>[0];
    }
  >
> = {
  "onboarding-preference-failed": {
    detail: "host.feedback.onboarding-preference-failed.detail",
    severity: "warning",
    title: "host.feedback.onboarding-preference-failed.title",
  },
  "stroke-point-limit-reached": {
    detail: "host.feedback.stroke-point-limit-reached.detail",
    severity: "warning",
    title: "host.feedback.stroke-point-limit-reached.title",
  },
  "changes-save-failed": {
    detail: "host.feedback.changes-save-failed.detail",
    severity: "error",
    title: "host.feedback.changes-save-failed.title",
  },
  "clipboard-copy-fallback": {
    detail: "host.feedback.clipboard-copy-fallback.detail",
    severity: "warning",
    title: "host.feedback.clipboard-copy-fallback.title",
  },
  "clipboard-copy-failed": {
    detail: "host.feedback.clipboard-copy-failed.detail",
    severity: "error",
    title: "host.feedback.clipboard-copy-failed.title",
  },
  "clipboard-operation-busy": {
    detail: "host.feedback.clipboard-operation-busy.detail",
    severity: "warning",
    title: "host.feedback.clipboard-operation-busy.title",
  },
  "clipboard-paste-failed": {
    detail: "host.feedback.clipboard-paste-failed.detail",
    severity: "error",
    title: "host.feedback.clipboard-paste-failed.title",
  },
  "clipboard-paste-invalid": {
    detail: "host.feedback.clipboard-paste-invalid.detail",
    severity: "info",
    title: "host.feedback.clipboard-paste-invalid.title",
  },
  "clipboard-paste-read-failed": {
    detail: "host.feedback.clipboard-paste-read-failed.detail",
    severity: "error",
    title: "host.feedback.clipboard-paste-read-failed.title",
  },
  "clipboard-paste-stale": {
    detail: "host.feedback.clipboard-paste-stale.detail",
    severity: "warning",
    title: "host.feedback.clipboard-paste-stale.title",
  },
  "cut-selection-changed": {
    detail: "host.feedback.cut-selection-changed.detail",
    severity: "warning",
    title: "host.feedback.cut-selection-changed.title",
  },
  "drawing-load-failed": {
    detail: "host.feedback.drawing-load-failed.detail",
    severity: "error",
    title: "host.feedback.drawing-load-failed.title",
  },
  "drawing-version-changed": {
    detail: "host.feedback.drawing-version-changed.detail",
    severity: "warning",
    title: "host.feedback.drawing-version-changed.title",
  },
  "editor-activation-delayed": {
    detail: "host.feedback.editor-activation-delayed.detail",
    severity: "warning",
    title: "host.feedback.editor-activation-delayed.title",
  },
  "editor-start-failed": {
    detail: "host.feedback.editor-start-failed.detail",
    severity: "error",
    title: "host.feedback.editor-start-failed.title",
  },
  "embed-copy-clipboard-unavailable": {
    detail: "host.feedback.embed-copy-clipboard-unavailable.detail",
    severity: "error",
    title: "host.feedback.embed-copy-clipboard-unavailable.title",
  },
  "embed-copy-failed": {
    detail: "host.feedback.embed-copy-failed.detail",
    severity: "error",
    title: "host.feedback.embed-copy-clipboard-unavailable.title",
  },
  "embed-delete-failed": {
    detail: "host.feedback.embed-delete-failed.detail",
    severity: "error",
    title: "host.feedback.embed-delete-failed.title",
  },
  "embed-delete-file-kept": {
    detail: "host.feedback.embed-delete-file-kept.detail",
    severity: "warning",
    title: "host.feedback.embed-delete-file-kept.title",
  },
  "embed-delete-note-changed": {
    detail: "host.feedback.embed-delete-note-changed.detail",
    severity: "warning",
    title: "host.feedback.embed-delete-note-changed.title",
  },
  "embed-delete-references-unavailable": {
    detail: "host.feedback.embed-delete-references-unavailable.detail",
    severity: "warning",
    title: "host.feedback.embed-delete-references-unavailable.title",
  },
  "embed-open-failed": {
    detail: "host.feedback.embed-open-failed.detail",
    severity: "error",
    title: "host.feedback.embed-open-failed.title",
  },
  "embed-paste-cleanup-failed": {
    detail: "host.feedback.embed-paste-cleanup-failed.detail",
    severity: "error",
    title: "host.feedback.embed-paste-cleanup-failed.title",
  },
  "embed-paste-failed": {
    detail: "host.feedback.embed-paste-failed.detail",
    severity: "error",
    title: "host.feedback.embed-paste-failed.title",
  },
  "embed-paste-note-changed": {
    detail: "host.feedback.embed-paste-note-changed.detail",
    severity: "warning",
    title: "host.feedback.embed-paste-cleanup-failed.title",
  },
  "handwriting-inserted": {
    severity: "success",
    title: "host.feedback.handwriting-inserted.title",
  },
  "history-change-failed": {
    detail: "host.feedback.history-change-failed.detail",
    severity: "error",
    title: "host.feedback.history-change-failed.title",
  },
  "history-lock-required": {
    severity: "info",
    title: "host.feedback.history-lock-required.title",
  },
  "insertion-cleanup-failed": {
    detail: "host.feedback.insertion-cleanup-failed.detail",
    severity: "error",
    title: "host.feedback.insertion-cleanup-failed.title",
  },
  "insertion-failed": {
    detail: "host.feedback.embed-paste-failed.detail",
    severity: "error",
    title: "host.feedback.insertion-cleanup-failed.title",
  },
  "insertion-note-changed-cleaned": {
    detail: "host.feedback.insertion-note-changed-cleaned.detail",
    severity: "warning",
    title: "host.feedback.insertion-note-changed-cleaned.title",
  },
  "insertion-undo-edit-failed": {
    detail: "host.feedback.insertion-undo-edit-failed.detail",
    severity: "error",
    title: "host.feedback.insertion-undo-edit-failed.title",
  },
  "insertion-undo-file-kept": {
    detail: "host.feedback.insertion-undo-file-kept.detail",
    severity: "warning",
    title: "host.feedback.insertion-undo-file-kept.title",
  },
  "insertion-undo-note-changed": {
    detail: "host.feedback.insertion-undo-edit-failed.detail",
    severity: "warning",
    title: "host.feedback.insertion-undo-note-changed.title",
  },
  "placement-folder-fallback": {
    detail: "host.feedback.placement-folder-fallback.detail",
    severity: "warning",
    title: "host.feedback.placement-folder-fallback.title",
  },
  "recovery-copy-saved": {
    severity: "success",
    title: "host.feedback.recovery-copy-saved.title",
  },
};

export function feedbackContent(
  code: InkbookFeedbackCode,
  t: Translator = new Localization().t,
): InkbookFeedbackContent {
  const content = FEEDBACK[code];
  return {
    severity: content.severity,
    title: t(content.title),
    ...(content.detail === undefined ? {} : { detail: t(content.detail) }),
  };
}
