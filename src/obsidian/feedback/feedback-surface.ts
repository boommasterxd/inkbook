import { setIcon } from "obsidian";

import type { InkbookFeedbackContent, InkbookFeedbackSeverity } from "./feedback-catalog";

const STATUS_ICONS: Readonly<Record<InkbookFeedbackSeverity, string>> = {
  error: "circle-alert",
  info: "info",
  success: "circle-check",
  warning: "triangle-alert",
};

export type InkbookFeedbackActionId =
  | "close-recovery"
  | "continue-editing"
  | "delete"
  | "dismiss"
  | "keep-preview"
  | "open-settings"
  | "reload-external"
  | "retry-open"
  | "retry-save"
  | "save-copy"
  | "undo-insertion";

interface InkbookFeedbackActionPresentation {
  readonly icon: string;
  readonly label: string;
  readonly tone?: "danger" | "normal";
}

const ACTIONS: Readonly<Record<InkbookFeedbackActionId, InkbookFeedbackActionPresentation>> = {
  "close-recovery": { icon: "x", label: "Close recovery dialog" },
  "continue-editing": { icon: "pencil", label: "Continue editing" },
  delete: { icon: "trash-2", label: "Delete", tone: "danger" },
  dismiss: { icon: "x", label: "Dismiss" },
  "keep-preview": { icon: "x", label: "Keep saved preview" },
  "open-settings": { icon: "settings", label: "Open settings" },
  "reload-external": { icon: "refresh-cw", label: "Reload external version" },
  "retry-open": { icon: "rotate-ccw", label: "Retry opening drawing" },
  "retry-save": { icon: "rotate-ccw", label: "Retry save" },
  "save-copy": { icon: "copy-plus", label: "Save copy" },
  "undo-insertion": { icon: "undo-2", label: "Undo insertion" },
};

export interface InkbookFeedbackAction {
  readonly id: InkbookFeedbackActionId;
  readonly run: () => boolean | Promise<boolean | void> | void;
}

export interface InkbookFeedbackSurface {
  readonly actionGroup: HTMLElement;
  readonly element: HTMLElement;
  readonly title: HTMLElement;
}

export function createFeedbackSurface(
  container: HTMLElement,
  content: InkbookFeedbackContent,
): InkbookFeedbackSurface {
  const element = container.createDiv({ cls: "inkbook-feedback" });
  element.dataset.inkbookFeedbackSeverity = content.severity;
  element.setAttribute("aria-atomic", "true");
  element.setAttribute("role", content.severity === "error" ? "alert" : "status");
  const status = element.createSpan({ cls: "inkbook-feedback-status-icon" });
  status.setAttribute("aria-hidden", "true");
  setIcon(status, STATUS_ICONS[content.severity]);
  const copy = element.createDiv({ cls: "inkbook-feedback-copy" });
  const title = copy.createDiv({ cls: "inkbook-feedback-title" });
  title.textContent = content.title;
  if (content.detail !== undefined) {
    const detail = copy.createDiv({ cls: "inkbook-feedback-detail" });
    detail.textContent = content.detail;
  }
  const actionGroup = element.createDiv({ cls: "inkbook-feedback-actions" });
  return { actionGroup, element, title };
}

export function createFeedbackIconButton(
  container: HTMLElement,
  actionId: InkbookFeedbackActionId,
): HTMLButtonElement {
  const action = ACTIONS[actionId];
  const button = container.createEl("button", {
    cls: "inkbook-feedback-icon-button",
  });
  button.type = "button";
  button.setAttribute("aria-label", action.label);
  button.setAttribute("title", action.label);
  if (action.tone !== undefined) button.dataset.inkbookFeedbackTone = action.tone;
  const icon = button.createSpan({ cls: "inkbook-feedback-action-icon" });
  icon.setAttribute("aria-hidden", "true");
  setIcon(icon, action.icon);
  return button;
}

export function setFeedbackPending(element: HTMLElement, pending: boolean): void {
  const buttons = element.getElementsByTagName("button");
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons.item(index);
    if (button !== null) button.disabled = pending;
  }
}
