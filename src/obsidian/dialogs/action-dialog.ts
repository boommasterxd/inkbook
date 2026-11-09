import { bindElementLanguage } from "../../rendering/localization/element-language";
import { Localization } from "../../domain/localization";
import type { ObserveMotion } from "../runtime/effective-motion";
import type { App } from "obsidian";

import type { MotionPreference } from "../../rendering/motion/transitions";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

import { InkbookModal } from "./inkbook-modal";
import { registerNativeControlFeedback } from "../menus/feedback/native-control-feedback";

type DialogText = string | (() => string);

function resolveText(text: DialogText): string {
  return typeof text === "function" ? text() : text;
}

interface DialogAction<T extends string> {
  readonly value: T;
  readonly label: DialogText;
  readonly description?: DialogText;
  readonly destructive?: boolean;
}

interface ActionDialogOptions<T extends string> {
  readonly workScheduler?: ((ownerWindow: Window | null) => WorkScheduler) | undefined;
  readonly title: DialogText;
  readonly description: DialogText;
  readonly actions: readonly DialogAction<T>[];
  readonly cancelLabel?: DialogText;
  readonly localization?: Localization | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly readMotion?: (() => MotionPreference) | undefined;
  readonly observeMotion?: ObserveMotion | undefined;
}

interface ConfirmationOptions {
  readonly workScheduler?: ((ownerWindow: Window | null) => WorkScheduler) | undefined;
  readonly title: DialogText;
  readonly description: DialogText;
  readonly confirmLabel: DialogText;
  readonly cancelLabel?: DialogText;
  readonly localization?: Localization | undefined;
  readonly destructive?: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly readMotion?: (() => MotionPreference) | undefined;
  readonly observeMotion?: ObserveMotion | undefined;
}

class InkbookActionDialog<T extends string> extends InkbookModal {
  readonly #options: ActionDialogOptions<T>;
  readonly #localization: Localization;
  readonly #resolve: (value: T | null) => void;
  #result: T | null = null;
  readonly #refreshText: Array<() => void> = [];
  #releaseLanguage: (() => void) | undefined;
  #releaseFeedback: (() => void) | undefined;

  public constructor(
    app: App,
    options: ActionDialogOptions<T>,
    resolve: (value: T | null) => void,
  ) {
    super(app, options.readMotion, options.workScheduler, options.observeMotion);
    this.#options = options;
    this.#localization = options.localization ?? new Localization();
    this.#resolve = resolve;
  }

  public override onOpen(): void {
    super.onOpen();
    this.#refreshText.push(() => {
      const title = resolveText(this.#options.title);
      this.setTitle(title);
      this.modalEl.setAttribute("aria-label", title);
    });
    const description = this.contentEl.createEl("p", {
      cls: "inkbook-dialog-description",
      text: resolveText(this.#options.description),
    });
    this.#refreshText.push(() => {
      description.textContent = resolveText(this.#options.description);
    });
    description.id = `inkbook-dialog-${this.contentEl.ownerDocument.defaultView?.crypto.randomUUID()}`;
    this.modalEl.setAttribute("aria-describedby", description.id);
    const actions = this.contentEl.createDiv({ cls: "inkbook-dialog-actions" });
    const cancel = this.#button(
      actions,
      this.#options.cancelLabel ?? (() => this.#localization.t("host.dialog.cancel")),
      () => this.close(),
    );
    cancel.autofocus = true;
    for (const action of this.#options.actions) this.#addAction(actions, action);
    this.#releaseFeedback = registerNativeControlFeedback(actions, {
      readMotion: this.#options.readMotion ?? (() => "system"),
      ...(this.#options.observeMotion === undefined
        ? {}
        : { observeMotion: this.#options.observeMotion }),
    });
    const cancelOwner = (): void => {
      this.#result = null;
      this.closeImmediately();
    };
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    if (ownerWindow !== null) this.listen(ownerWindow, "pagehide", cancelOwner);
    if (this.#options.signal !== undefined) {
      this.listen(this.#options.signal, "abort", cancelOwner);
    }
    const refresh = (): void => {
      for (const update of this.#refreshText) update();
    };
    refresh();
    const releaseLanguage = bindElementLanguage(this.modalEl, this.#localization);
    const unsubscribe = this.#localization.subscribe(refresh);
    this.#releaseLanguage = () => {
      unsubscribe();
      releaseLanguage();
    };
    cancel.focus();
    if (this.#options.signal?.aborted === true) this.closeImmediately();
  }

  public override onClose(): void {
    if (this.closed) return;
    this.#releaseLanguage?.();
    this.#refreshText.length = 0;
    this.#releaseFeedback?.();
    this.#releaseFeedback = undefined;
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
      const label = detail.createEl("strong");
      const description = detail.createSpan();
      this.#refreshText.push(() => {
        label.textContent = `${resolveText(action.label)}: `;
        description.textContent =
          action.description === undefined ? "" : resolveText(action.description);
      });
      detail.id = `inkbook-choice-${this.contentEl.ownerDocument.defaultView?.crypto.randomUUID()}`;
      button.setAttribute("aria-describedby", detail.id);
      this.contentEl.insertBefore(detail, container);
    }
  }

  #button(container: HTMLElement, label: DialogText, callback: () => void): HTMLButtonElement {
    const button = container.createEl("button", { text: resolveText(label) });
    this.#refreshText.push(() => {
      button.textContent = resolveText(label);
    });
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
