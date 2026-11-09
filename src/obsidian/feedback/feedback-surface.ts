import { bindElementLanguage } from "../../rendering/localization/element-language";
import { Localization, type Translator } from "../../domain/localization";
import { setIcon } from "obsidian";

import {
  feedbackContent,
  type InkbookFeedbackCode,
  type InkbookFeedbackContent,
  type InkbookFeedbackSeverity,
} from "./feedback-catalog";

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
  readonly label: Parameters<Translator>[0];
  readonly tone?: "danger" | "normal";
}

const ACTIONS: Readonly<Record<InkbookFeedbackActionId, InkbookFeedbackActionPresentation>> = {
  "close-recovery": { icon: "x", label: "host.action.close-recovery" },
  "continue-editing": { icon: "pencil", label: "host.action.continue-editing" },
  delete: { icon: "trash-2", label: "host.action.delete", tone: "danger" },
  dismiss: { icon: "x", label: "host.action.dismiss" },
  "keep-preview": { icon: "x", label: "host.action.keep-preview" },
  "open-settings": { icon: "settings", label: "host.action.open-settings" },
  "reload-external": { icon: "refresh-cw", label: "host.action.reload-external" },
  "retry-open": { icon: "rotate-ccw", label: "host.action.retry-open" },
  "retry-save": { icon: "rotate-ccw", label: "host.action.retry-save" },
  "save-copy": { icon: "copy-plus", label: "host.action.save-copy" },
  "undo-insertion": { icon: "undo-2", label: "host.action.undo-insertion" },
};

export interface InkbookFeedbackAction {
  readonly id: InkbookFeedbackActionId;
  readonly run: () => boolean | Promise<boolean | void> | void;
}

export interface InkbookFeedbackSurface {
  readonly actionGroup: HTMLElement;
  readonly element: HTMLElement;
  readonly title: HTMLElement;
  readonly refresh: (content: InkbookFeedbackContent) => void;
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
  const detail =
    content.detail === undefined ? undefined : copy.createDiv({ cls: "inkbook-feedback-detail" });
  if (detail !== undefined) detail.textContent = content.detail ?? "";
  const actionGroup = element.createDiv({ cls: "inkbook-feedback-actions" });
  return {
    actionGroup,
    element,
    title,
    refresh: (next) => {
      title.textContent = next.title;
      if (detail !== undefined) detail.textContent = next.detail ?? "";
    },
  };
}

export function createFeedbackIconButton(
  container: HTMLElement,
  actionId: InkbookFeedbackActionId,
  t: Translator = new Localization().t,
): HTMLButtonElement {
  const action = ACTIONS[actionId];
  const button = container.createEl("button", {
    cls: "inkbook-feedback-icon-button",
  });
  button.type = "button";
  button.dataset.inkbookFeedbackAction = actionId;
  refreshFeedbackIconButton(button, actionId, t);
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

export function refreshFeedbackIconButton(
  button: HTMLButtonElement,
  actionId: InkbookFeedbackActionId,
  t: Translator,
): void {
  const label = t(ACTIONS[actionId].label);
  button.setAttribute("aria-label", label);
  button.title = label;
}

export function bindFeedbackLocalization(
  surface: InkbookFeedbackSurface,
  localization: Localization,
  code: InkbookFeedbackCode,
): () => void {
  const releaseLanguage = bindElementLanguage(surface.element, localization);
  const unsubscribe = localization.subscribe(() => {
    surface.refresh(feedbackContent(code, localization.t));
    const buttons = surface.actionGroup.getElementsByTagName("button");
    for (let index = 0; index < buttons.length; index += 1) {
      const button = buttons.item(index);
      if (button === null) continue;
      const action = button.dataset.inkbookFeedbackAction as InkbookFeedbackActionId;
      refreshFeedbackIconButton(button, action, localization.t);
    }
  });
  return () => {
    unsubscribe();
    releaseLanguage();
  };
}
