import { setIcon } from "obsidian";

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

export function showAttachedRecoveryPanel(
  root: HTMLElement,
  actions: AttachedRecoveryActions,
  onClosed: () => void,
): HTMLElement {
  const panel = root.createDiv({ cls: "inkbook-recovery" });
  panel.setAttribute("role", "alert");
  panel.setAttribute("aria-label", "Save failed");
  const message = panel.createDiv({ cls: "inkbook-recovery-message" });
  message.textContent = "Could not save changes";
  const actionGroup = panel.createDiv({ cls: "inkbook-recovery-actions" });
  const retry = createRecoveryIconButton(actionGroup, "Retry save", "rotate-ccw");
  const saveCopy = createRecoveryIconButton(actionGroup, "Save copy", "copy-plus");
  const cancel = createRecoveryIconButton(actionGroup, "Continue editing", "pencil");
  retry.addEventListener("click", () => runAttachedAction(panel, () => actions.retry(), onClosed));
  saveCopy.addEventListener("click", () => {
    setPending(panel, true);
    void actions
      .saveLocalCopy()
      .then((confirmed) => finishAttachedAction(panel, confirmed, onClosed))
      .catch(() => setPending(panel, false));
  });
  cancel.addEventListener("click", () =>
    runAttachedAction(panel, () => actions.cancel(), onClosed),
  );
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
  const closeButton = createRecoveryIconButton(dialog, "Close recovery dialog", "x");
  const title = dialog.createEl("h2", { text: "Inkbook could not save this drawing" });
  dialog.createEl("p", { text: "Unsaved changes remain available for recovery." });
  const actionsElement = dialog.createDiv({ cls: "inkbook-recovery-actions" });
  const retry = createRecoveryIconButton(actionsElement, "Retry", "rotate-ccw");
  const reload = createRecoveryIconButton(actionsElement, "Reload external version", "refresh-cw");
  const saveCopy = createRecoveryIconButton(actionsElement, "Save local copy", "copy-plus");
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

function recoveryButton(container: HTMLElement, text: string, label?: string): HTMLButtonElement {
  const button = container.createEl("button", { text });
  button.type = "button";
  button.textContent = text;
  if (label !== undefined) button.setAttribute("aria-label", label);
  return button;
}

export function createRecoveryIconButton(
  container: HTMLElement,
  label: string,
  icon: string,
): HTMLButtonElement {
  const button = recoveryButton(container, "", label);
  button.setAttribute("class", "inkbook-recovery-icon-button");
  button.setAttribute("title", label);
  const iconElement = button.createSpan({ cls: "inkbook-recovery-action-icon" });
  setIcon(iconElement, icon);
  return button;
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
  const buttons = message.getElementsByTagName("button");
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons.item(index);
    if (button !== null) button.disabled = pending;
  }
}

function runAttachedAction(panel: HTMLElement, action: () => boolean, onClosed: () => void): void {
  setPending(panel, true);
  try {
    finishAttachedAction(panel, action(), onClosed);
  } catch {
    setPending(panel, false);
  }
}

function finishAttachedAction(panel: HTMLElement, confirmed: boolean, onClosed: () => void): void {
  if (!confirmed) {
    setPending(panel, false);
    return;
  }
  panel.remove();
  onClosed();
}
