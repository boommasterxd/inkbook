import type { DocumentSaveStatus } from "../../editor/session/session-port";

const LABELS: Readonly<Record<DocumentSaveStatus, string>> = {
  saved: "Saved",
  pending: "Unsaved changes",
  saving: "Saving",
  failed: "Save failed",
};

const DETAILS: Readonly<Record<DocumentSaveStatus, string>> = {
  saved: "All current changes have been saved.",
  pending: "Current changes are waiting for autosave.",
  saving: "Current changes are being saved.",
  failed: "Saving requires attention. Your local changes remain in this session.",
};

export function DocumentSaveStatusIndicator(props: { readonly status: DocumentSaveStatus }) {
  return (
    <span
      aria-atomic="true"
      aria-live="polite"
      className="inkbook-document-save-status"
      data-save-status={props.status}
      role="status"
      title={DETAILS[props.status]}
    >
      {LABELS[props.status]}
    </span>
  );
}
