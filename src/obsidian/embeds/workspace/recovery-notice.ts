import { bindElementLanguage } from "../../../rendering/localization/element-language";
import { Localization } from "../../../domain/localization";
import type { App } from "obsidian";

import type { MotionPreference } from "../../../rendering/motion/transitions";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

import { InkbookModal } from "../../dialogs/inkbook-modal";

import { feedbackContent, type InkbookFeedbackCode } from "../../feedback/feedback-catalog";
import {
  createFeedbackIconButton,
  bindFeedbackLocalization,
  createFeedbackSurface,
  setFeedbackPending,
} from "../../feedback/feedback-surface";
import { mountWindowFeedback } from "../../feedback/window-feedback-host";

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
  localization = new Localization(),
): AttachedRecoveryPanel {
  const surface = createFeedbackSurface(root, feedbackContent(code, localization.t));
  const releaseLanguage = bindFeedbackLocalization(surface, localization, code);
  const panel = createAttachedPanel(root, surface.element, () => {
    releaseLanguage();
    onClosed();
  });
  const retry = createFeedbackIconButton(surface.actionGroup, "retry-open", localization.t);
  const discard = createFeedbackIconButton(surface.actionGroup, "keep-preview", localization.t);
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
  localization = new Localization(),
): AttachedRecoveryPanel {
  const surface = createFeedbackSurface(
    root,
    feedbackContent("changes-save-failed", localization.t),
  );
  const releaseLanguage = bindFeedbackLocalization(surface, localization, "changes-save-failed");
  const panel = createAttachedPanel(root, surface.element, () => {
    releaseLanguage();
    onClosed();
  });
  const retry = createFeedbackIconButton(surface.actionGroup, "retry-save", localization.t);
  const saveCopy = createFeedbackIconButton(surface.actionGroup, "save-copy", localization.t);
  const cancel = createFeedbackIconButton(surface.actionGroup, "continue-editing", localization.t);
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
  #releaseLanguage: (() => void) | undefined;

  constructor(
    app: App,
    actions: HeadlessRecoveryActions,
    readMotion: (() => MotionPreference) | undefined,
    private readonly localization: Localization,
    workScheduler?: (ownerWindow: Window | null) => WorkScheduler,
  ) {
    super(app, readMotion, workScheduler);
    this.#actions = actions;
  }

  override onOpen(): void {
    super.onOpen();
    this.setTitle(this.localization.t("host.recovery.title"));
    this.modalEl.setAttribute("aria-label", this.localization.t("host.recovery.title"));
    const content = feedbackContent("changes-save-failed", this.localization.t);
    const description = this.contentEl.createEl("p", {
      cls: "inkbook-dialog-description",
      text: `${content.title} ${content.detail ?? ""}`.trim(),
    });
    description.id = "inkbook-recovery-description";
    this.modalEl.setAttribute("aria-describedby", description.id);
    const actions = this.contentEl.createDiv({
      cls: "inkbook-dialog-actions inkbook-recovery-actions",
    });
    const retry = this.#textButton(actions, this.localization.t("host.recovery.retry"));
    const reload = this.#textButton(actions, this.localization.t("host.action.reload-external"));
    const saveCopy = this.#textButton(actions, this.localization.t("host.action.save-copy"));
    retry.classList.add("mod-cta");
    retry.autofocus = true;
    this.listen(retry, "click", () => this.#retry());
    this.listen(reload, "click", () => {
      void this.#runAction(() => this.#actions.reloadExternal());
    });
    this.listen(saveCopy, "click", () => {
      void this.#runAction(() => this.#actions.saveLocalCopy());
    });
    const releaseLanguage = bindElementLanguage(this.modalEl, this.localization);
    const unsubscribe = this.localization.subscribe(() => {
      this.setTitle(this.localization.t("host.recovery.title"));
      this.modalEl.setAttribute("aria-label", this.localization.t("host.recovery.title"));
      const translated = feedbackContent("changes-save-failed", this.localization.t);
      description.textContent = `${translated.title} ${translated.detail ?? ""}`.trim();
      retry.textContent = this.localization.t("host.recovery.retry");
      reload.textContent = this.localization.t("host.action.reload-external");
      saveCopy.textContent = this.localization.t("host.action.save-copy");
    });
    this.#releaseLanguage = () => {
      unsubscribe();
      releaseLanguage();
    };
    retry.focus();
  }

  override onClose(): void {
    this.#releaseLanguage?.();
    this.#releaseLanguage = undefined;
    super.onClose();
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
  localization = new Localization(),
  workScheduler?: (ownerWindow: Window | null) => WorkScheduler,
): HeadlessRecoveryNotice {
  const dialog = new HeadlessRecoveryModal(app, actions, readMotion, localization, workScheduler);
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
