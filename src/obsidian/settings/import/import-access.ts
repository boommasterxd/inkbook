import type { App } from "obsidian";

import type { InkImportJournal } from "../../import/types";
import { InkImportDialog, type InkImportDialogOptions } from "./ink-import-dialog";

export interface InkImportSettingsAccess {
  readonly open: (
    ownerWindow: Window | null,
    journal?: InkImportJournal,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly history: (
    ownerWindow: Window | null,
    signal: AbortSignal,
  ) => Promise<readonly InkImportJournal[]>;
  readonly subscribe: (listener: () => void) => () => void;
}

interface InkImportAccessOptions extends Omit<InkImportDialogOptions, "service" | "signal"> {
  readonly app: App;
  readonly signal: AbortSignal;
  readonly createService: (ownerWindow: Window) => InkImportDialogOptions["service"];
}

/** Serializes journal reconciliation with the complete import-dialog lifetime. */
export class InkImportAccess implements InkImportSettingsAccess {
  readonly #options: InkImportAccessOptions;
  readonly #listeners = new Set<() => void>();
  #dialog: InkImportDialog | undefined;
  #opening = false;
  #historyController: AbortController | undefined;
  #historyTail: Promise<void> = Promise.resolve();

  public constructor(options: InkImportAccessOptions) {
    this.#options = options;
    options.signal.addEventListener("abort", () => this.#listeners.clear(), { once: true });
  }

  public async open(
    ownerWindow: Window | null,
    journal?: InkImportJournal,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      ownerWindow === null ||
      this.#options.signal.aborted ||
      signal?.aborted === true ||
      this.#dialog ||
      this.#opening
    )
      return;
    this.#opening = true;
    try {
      this.#historyController?.abort();
      await this.#historyTail;
      if (this.#options.signal.aborted || signal?.aborted) return;
      const dialog = new InkImportDialog(this.#options.app, {
        service: this.#options.createService(ownerWindow),
        localization: this.#options.localization,
        signal: this.#options.signal,
        readMotion: this.#options.readMotion,
        workScheduler: this.#options.workScheduler,
        ...(this.#options.observeMotion === undefined
          ? {}
          : { observeMotion: this.#options.observeMotion }),
        ...(journal === undefined ? {} : { initialJournal: journal }),
        onClose: () => {
          if (this.#dialog !== dialog) return;
          this.#dialog = undefined;
          for (const listener of [...this.#listeners]) listener();
        },
      });
      this.#dialog = dialog;
      dialog.open();
    } finally {
      this.#opening = false;
    }
  }

  public history(
    ownerWindow: Window | null,
    signal: AbortSignal,
  ): Promise<readonly InkImportJournal[]> {
    const operation = this.#historyTail.then(async () => {
      signal.throwIfAborted();
      this.#options.signal.throwIfAborted();
      if (ownerWindow === null)
        throw new Error(this.#options.localization.t("import.windowUnavailable"));
      if (this.#dialog !== undefined || this.#opening)
        throw new Error(this.#options.localization.t("import.windowBusy"));
      const controller = new AbortController();
      this.#historyController = controller;
      const lifetime = AbortSignal.any([signal, controller.signal, this.#options.signal]);
      try {
        const history = await this.#options.createService(ownerWindow).history(lifetime);
        lifetime.throwIfAborted();
        return history;
      } finally {
        this.#historyController = undefined;
      }
    });
    this.#historyTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public subscribe(listener: () => void): () => void {
    if (!this.#options.signal.aborted) this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
