import { feedbackContent, type InkbookFeedbackCode } from "../feedback/feedback-catalog";
import {
  createFeedbackIconButton,
  createFeedbackSurface,
  setFeedbackPending,
} from "../feedback/feedback-surface";
import { createPresentationFeedbackPositionLifecycle } from "../feedback/presentation-feedback-position";

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

export function showHeadlessRecoveryNotice(
  _documentId: string,
  actions: HeadlessRecoveryActions,
  resolveDocument: () => Document = () => activeDocument,
): HeadlessRecoveryNotice {
  let ownerDocument: Document | undefined = resolveDocument();
  const mountingDocument = ownerDocument;
  let previousFocus = mountingDocument.activeElement as HTMLElement | null;
  let overlay: HTMLElement | undefined = mountingDocument.body.createDiv({
    cls: "inkbook-root inkbook-recovery-overlay",
  });
  let dialog: HTMLElement | undefined = overlay.createDiv({
    cls: "inkbook-headless-recovery-dialog",
  });
  const closeButton = createFeedbackIconButton(dialog, "close-recovery");
  closeButton.classList.add("inkbook-headless-recovery-close");
  const surface = createFeedbackSurface(dialog, feedbackContent("changes-save-failed"));
  surface.element.classList.add("inkbook-feedback-headless");
  const title = surface.title;
  const retry = createFeedbackIconButton(surface.actionGroup, "retry-save");
  const reload = createFeedbackIconButton(surface.actionGroup, "reload-external");
  const saveCopy = createFeedbackIconButton(surface.actionGroup, "save-copy");
  const focusable = [closeButton, retry, reload, saveCopy];
  const listeners: Array<readonly [EventTarget, string, EventListener]> = [];
  title.id = "inkbook-headless-recovery-title";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", title.id);

  const close = (): void => {
    if (overlay === undefined) return;
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    listeners.length = 0;
    overlay.remove();
    try {
      previousFocus?.focus();
    } catch {
      // The previously focused host element may have detached with its pop-out window.
    }
    previousFocus = null;
    overlay = undefined;
    dialog = undefined;
    ownerDocument = undefined;
  };
  const listen = (target: EventTarget, type: string, listener: EventListener): void => {
    target.addEventListener(type, listener);
    listeners.push([target, type, listener]);
  };
  listen(closeButton, "click", close);
  listen(mountingDocument, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === "Escape") {
      close();
      return;
    }
    if (keyboardEvent.key === "Tab") {
      trapRecoveryFocus(keyboardEvent, mountingDocument.activeElement, focusable);
    }
  });
  listen(retry, "click", () => {
    const current = dialog;
    if (current === undefined) return;
    setPending(current, true);
    try {
      if (actions.retry()) close();
      else setPending(current, false);
    } catch {
      setPending(current, false);
    }
  });
  listen(reload, "click", () => {
    void runRecoveryAction(
      () => dialog,
      close,
      () => actions.reloadExternal(),
    );
  });
  listen(saveCopy, "click", () => {
    void runRecoveryAction(
      () => dialog,
      close,
      () => actions.saveLocalCopy(),
    );
  });
  retry.focus();
  return { close };
}

function trapRecoveryFocus(
  event: KeyboardEvent,
  activeElement: Element | null,
  focusable: readonly HTMLButtonElement[],
): void {
  const current = focusable.indexOf(activeElement as HTMLButtonElement);
  const boundary = event.shiftKey ? 0 : focusable.length - 1;
  if (current !== -1 && current !== boundary) return;
  event.preventDefault();
  focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
}

async function runRecoveryAction(
  currentDialog: () => HTMLElement | undefined,
  close: () => void,
  action: () => Promise<boolean>,
): Promise<void> {
  const dialog = currentDialog();
  if (dialog === undefined) return;
  setPending(dialog, true);
  try {
    if (await action()) close();
    else if (currentDialog() === dialog) setPending(dialog, false);
  } catch {
    if (currentDialog() === dialog) setPending(dialog, false);
  }
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
  const positioning = createPresentationFeedbackPositionLifecycle(element, root);
  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      positioning.dispose();
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
