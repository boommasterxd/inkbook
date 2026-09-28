import type { App } from "obsidian";

import type { MotionPreference } from "../../rendering/motion/transitions";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

import { InkbookModal } from "./inkbook-modal";

interface DialogAction<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly destructive?: boolean;
}

interface ActionDialogOptions<T extends string> {
  readonly workScheduler?: ((ownerWindow: Window | null) => WorkScheduler) | undefined;
  readonly title: string;
  readonly description: string;
  readonly actions: readonly DialogAction<T>[];
  readonly cancelLabel?: string;
  readonly signal?: AbortSignal | undefined;
  readonly readMotion?: (() => MotionPreference) | undefined;
}

interface ConfirmationOptions {
  readonly workScheduler?: ((ownerWindow: Window | null) => WorkScheduler) | undefined;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly readMotion?: (() => MotionPreference) | undefined;
}

class InkbookActionDialog<T extends string> extends InkbookModal {
  readonly #options: ActionDialogOptions<T>;
  readonly #resolve: (value: T | null) => void;
  #result: T | null = null;

  public constructor(
    app: App,
    options: ActionDialogOptions<T>,
    resolve: (value: T | null) => void,
  ) {
    super(app, options.readMotion, options.workScheduler);
    this.#options = options;
    this.#resolve = resolve;
  }

  public override onOpen(): void {
    super.onOpen();
    this.setTitle(this.#options.title);
    this.modalEl.setAttribute("aria-label", this.#options.title);
    const description = this.contentEl.createEl("p", {
      cls: "inkbook-dialog-description",
      text: this.#options.description,
    });
    description.id = `inkbook-dialog-${this.contentEl.ownerDocument.defaultView?.crypto.randomUUID()}`;
    this.modalEl.setAttribute("aria-describedby", description.id);
    const actions = this.contentEl.createDiv({ cls: "inkbook-dialog-actions" });
    const cancel = this.#button(actions, this.#options.cancelLabel ?? "Cancel", () => this.close());
    cancel.autofocus = true;
    for (const action of this.#options.actions) this.#addAction(actions, action);
    const cancelOwner = (): void => {
      this.#result = null;
      this.closeImmediately();
    };
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    if (ownerWindow !== null) this.listen(ownerWindow, "pagehide", cancelOwner);
    if (this.#options.signal !== undefined) {
      this.listen(this.#options.signal, "abort", cancelOwner);
    }
    cancel.focus();
    if (this.#options.signal?.aborted === true) this.closeImmediately();
  }

  public override onClose(): void {
    if (this.closed) return;
    super.onClose();
    this.#resolve(this.#result);
  }

  #addAction(container: HTMLElement, action: DialogAction<T>): void {
    const button = this.#button(container, action.label, () => {
      if (this.closed || this.closing) return;
      this.#result = action.value;
      this.close();
    });
    button.classList.add(action.destructive === true ? "mod-warning" : "mod-cta");
    if (action.description !== undefined) {
      button.classList.remove("mod-cta");
      const detail = this.contentEl.createEl("p", { cls: "inkbook-dialog-choice-description" });
      detail.createEl("strong", { text: `${action.label}: ` });
      detail.createSpan({ text: action.description });
      detail.id = `inkbook-choice-${this.contentEl.ownerDocument.defaultView?.crypto.randomUUID()}`;
      button.setAttribute("aria-describedby", detail.id);
      this.contentEl.insertBefore(detail, container);
    }
  }

  #button(container: HTMLElement, label: string, callback: () => void): HTMLButtonElement {
    const button = container.createEl("button", { text: label });
    button.type = "button";
    this.listen(button, "click", callback);
    return button;
  }
}

export function chooseInkbookAction<T extends string>(
  app: App,
  options: ActionDialogOptions<T>,
): Promise<T | null> {
  if (options.signal?.aborted === true) return Promise.resolve(null);
  return new Promise((resolve) => new InkbookActionDialog(app, options, resolve).open());
}

export async function confirmInkbookAction(
  app: App,
  options: ConfirmationOptions,
): Promise<boolean> {
  return (
    (await chooseInkbookAction(app, {
      ...options,
      actions: [
        {
          value: "confirm",
          label: options.confirmLabel,
          destructive: options.destructive === true,
        },
      ],
    })) === "confirm"
  );
}
