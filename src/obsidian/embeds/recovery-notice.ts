import type { App } from "obsidian";

import type { MotionPreference } from "../../rendering/motion/transitions";

import { InkbookModal } from "../dialogs/inkbook-modal";

import { feedbackContent, type InkbookFeedbackCode } from "../feedback/feedback-catalog";
import {
  createFeedbackIconButton,
  createFeedbackSurface,
  setFeedbackPending,
} from "../feedback/feedback-surface";
import { mountWindowFeedback } from "../feedback/window-feedback-host";

export interface HeadlessRecoveryActions {
  reloadExternal(): Promise<boolean>;
  retry(): boolean;
  saveLocalCopy(): Promise<boolean>;
}

export interface HeadlessRecoveryNotice {
  close(): void;
}

export interface AttachedRecoveryActions {
  cancel(): boolean;
  retry(): boolean;
  saveLocalCopy(): Promise<boolean>;
}

export interface AttachedRecoveryPanel {
  readonly element: HTMLElement;
  close(): void;
}

export interface LoadRecoveryActions {
  discard(): boolean;
  retry(): void;
}

export function showLoadRecoveryPanel(
  root: HTMLElement,
  actions: LoadRecoveryActions,
  onClosed: () => void,
  code: Extract<
    InkbookFeedbackCode,
    "drawing-load-failed" | "drawing-version-changed" | "editor-start-failed"
  >,
): AttachedRecoveryPanel {
  const surface = createFeedbackSurface(root, feedbackContent(code));
  const panel = createAttachedPanel(root, surface.element, onClosed);
  const retry = createFeedbackIconButton(surface.actionGroup, "retry-open");
  const discard = createFeedbackIconButton(surface.actionGroup, "keep-preview");
  retry.addEventListener("click", () => {
    panel.close();
    actions.retry();
  });
  discard.addEventListener("click", () => runAttachedAction(panel, () => actions.discard()));
  return panel;
}

export function showAttachedRecoveryPanel(
  root: HTMLElement,
  actions: AttachedRecoveryActions,
  onClosed: () => void,
): AttachedRecoveryPanel {
  const surface = createFeedbackSurface(root, feedbackContent("changes-save-failed"));
  const panel = createAttachedPanel(root, surface.element, onClosed);
  const retry = createFeedbackIconButton(surface.actionGroup, "retry-save");
  const saveCopy = createFeedbackIconButton(surface.actionGroup, "save-copy");
  const cancel = createFeedbackIconButton(surface.actionGroup, "continue-editing");
  retry.addEventListener("click", () => runAttachedAction(panel, () => actions.retry()));
  saveCopy.addEventListener("click", () => {
    setPending(panel.element, true);
    void actions
      .saveLocalCopy()
      .then((confirmed) => finishAttachedAction(panel, confirmed))
      .catch(() => setPending(panel.element, false));
  });
  cancel.addEventListener("click", () => runAttachedAction(panel, () => actions.cancel()));
  return panel;
}

class HeadlessRecoveryModal extends InkbookModal {
  readonly #actions: HeadlessRecoveryActions;
  #pending = false;

  constructor(app: App, actions: HeadlessRecoveryActions, readMotion?: () => MotionPreference) {
    super(app, readMotion);
    this.#actions = actions;
  }

  override onOpen(): void {
    super.onOpen();
    this.setTitle("Recover changes");
    this.modalEl.setAttribute("aria-label", "Recover changes");
    const content = feedbackContent("changes-save-failed");
    const description = this.contentEl.createEl("p", {
      cls: "inkbook-dialog-description",
      text: `${content.title} ${content.detail ?? ""}`.trim(),
    });
    description.id = "inkbook-recovery-description";
    this.modalEl.setAttribute("aria-describedby", description.id);
    const actions = this.contentEl.createDiv({
      cls: "inkbook-dialog-actions inkbook-recovery-actions",
    });
    const retry = this.#textButton(actions, "Retry");
    const reload = this.#textButton(actions, "Reload external version");
    const saveCopy = this.#textButton(actions, "Save copy");
    retry.classList.add("mod-cta");
    retry.autofocus = true;
    this.listen(retry, "click", () => this.#retry());
    this.listen(reload, "click", () => {
      void this.#runAction(() => this.#actions.reloadExternal());
    });
    this.listen(saveCopy, "click", () => {
      void this.#runAction(() => this.#actions.saveLocalCopy());
    });
    retry.focus();
  }

  #textButton(container: HTMLElement, label: string): HTMLButtonElement {
    const button = container.createEl("button", { text: label });
    button.type = "button";
    return button;
  }

  #retry(): void {
    if (this.closed || this.closing || this.#pending) return;
    this.#setPending(true);
    try {
      if (this.#actions.retry()) this.close();
      else this.#setPending(false);
    } catch {
      this.#setPending(false);
    }
  }

  async #runAction(action: () => Promise<boolean>): Promise<void> {
    if (this.closed || this.closing || this.#pending) return;
    this.#setPending(true);
    try {
      if (await action()) {
        if (!this.closed) this.close();
      } else this.#setPending(false);
    } catch {
      this.#setPending(false);
    }
  }

  #setPending(pending: boolean): void {
    if (this.closed) return;
    this.#pending = pending;
    setFeedbackPending(this.contentEl, pending);
  }
}

export function showHeadlessRecoveryNotice(
  app: App,
  actions: HeadlessRecoveryActions,
  readMotion?: () => MotionPreference,
): HeadlessRecoveryNotice {
  const dialog = new HeadlessRecoveryModal(app, actions, readMotion);
  dialog.open();
  return { close: () => dialog.closeImmediately() };
}

function setPending(message: HTMLElement, pending: boolean): void {
  setFeedbackPending(message, pending);
}

function createAttachedPanel(
  root: HTMLElement,
  element: HTMLElement,
  onClosed: () => void,
): AttachedRecoveryPanel {
  element.classList.add("inkbook-feedback-presentation");
  const unmount = mountWindowFeedback(element, root);
  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      unmount();
      element.remove();
      onClosed();
    },
    element,
  };
}

function runAttachedAction(panel: AttachedRecoveryPanel, action: () => boolean): void {
  setPending(panel.element, true);
  try {
    finishAttachedAction(panel, action());
  } catch {
    setPending(panel.element, false);
  }
}

function finishAttachedAction(panel: AttachedRecoveryPanel, confirmed: boolean): void {
  if (!confirmed) {
    setPending(panel.element, false);
    return;
  }
  panel.close();
}
