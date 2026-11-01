import { Setting, type App } from "obsidian";

import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { MotionPreference } from "../../../rendering/motion/transitions";
import type { ObsidianInkImportService } from "../../import/service";
import type { InkImportJournal, InkImportPreview, InkImportResult } from "../../import/types";
import { InkbookModal } from "../../dialogs/inkbook-modal";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import { playMenuMotion } from "../../menus/feedback/menu-motion";
import {
  effectiveTransitionDuration,
  observeEffectiveMotion,
} from "../../runtime/effective-motion";
import {
  renderImportEntry,
  renderImportJournal,
  renderImportPreview,
  renderImportResult,
  type ImportOperation,
  type ImportViewContext,
} from "./import-view";
import { renderImportStatus, type PendingImportOperation } from "./import-status";

export interface InkImportDialogOptions {
  readonly service: Pick<
    ObsidianInkImportService,
    "scan" | "apply" | "history" | "undo" | "cleanup"
  >;
  readonly readMotion: () => MotionPreference;
  readonly observeMotion?: (listener: () => void) => () => void;
  readonly workScheduler: (ownerWindow: Window | null) => WorkScheduler;
  readonly signal?: AbortSignal | undefined;
  readonly initialJournal?: InkImportJournal | undefined;
  readonly onClose?: () => void;
}

/** One settings-owned import surface; all writes go through the journaled service. */
export class InkImportDialog extends InkbookModal {
  readonly #options: InkImportDialogOptions;
  readonly #lifetime = new AbortController();
  readonly #viewDisposers: Array<() => void> = [];
  #operation: AbortController | undefined;
  #body!: HTMLElement;
  #status!: HTMLElement;
  #actions!: HTMLElement;
  #feedback: ReturnType<typeof registerNativeControlFeedback> | undefined;
  #viewMotion: (() => void) | undefined;
  #releaseMotion: (() => void) | undefined;
  #returnFocus: HTMLElement | undefined;
  #closedNotified = false;

  public constructor(app: App, options: InkImportDialogOptions) {
    super(app, options.readMotion, options.workScheduler, options.observeMotion);
    this.#options = options;
  }

  public get isClosed(): boolean {
    return this.closed;
  }
  public get busy(): boolean {
    return this.#operation !== undefined;
  }

  protected override get phoneContentScroll(): HTMLElement | undefined {
    return this.#body;
  }

  public override open(): void {
    super.open();
    if (!this.closed && !this.closing) {
      this.#actions.querySelector<HTMLButtonElement>(".mod-cta")?.focus();
    }
  }

  public override onOpen(): void {
    super.onOpen();
    this.setTitle("Import from Obsidian Ink");
    this.containerEl.classList.add("inkbook-import-container");
    this.modalEl.classList.remove("inkbook-action-dialog");
    this.modalEl.classList.add("inkbook-settings-modal", "inkbook-import-dialog");
    this.titleEl.classList.add("inkbook-import-title");
    this.contentEl.classList.add("inkbook-import-content");
    const active = this.contentEl.ownerDocument.activeElement;
    if (active !== null && "focus" in active) this.#returnFocus = active as HTMLElement;
    this.#status = this.contentEl.createDiv({ cls: "inkbook-menu-visually-hidden" });
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    this.#status.setAttribute("aria-atomic", "true");
    this.#body = this.contentEl.createDiv({
      cls: "inkbook-import-body",
    });
    this.#actions = this.contentEl.createDiv({
      cls: "inkbook-import-actions",
    });
    this.#releaseMotion = observeEffectiveMotion(
      this.#body,
      this.#options.readMotion,
      (reduced) => {
        if (reduced) this.#finishViewMotion();
      },
      this.#options.observeMotion,
    );
    if (this.#options.initialJournal === undefined) this.#entry();
    else this.#journal(this.#options.initialJournal);
    this.#options.signal?.addEventListener("abort", this.#ownerClosed, {
      signal: this.#lifetime.signal,
    });
    this.#actions.querySelector<HTMLButtonElement>(".mod-cta")?.focus();
    if (this.#options.signal?.aborted === true) this.closeImmediately();
  }

  public override close(): void {
    this.#operation?.abort();
    super.close();
  }

  public override onClose(): void {
    if (this.closed) return;
    this.#operation?.abort();
    this.#lifetime.abort();
    this.#disposeView();
    this.#feedback?.();
    this.#finishViewMotion();
    this.#releaseMotion?.();
    super.onClose();
    if (this.#returnFocus?.isConnected === true) this.#returnFocus.focus();
    this.#notifyClosed();
  }

  #notifyClosed(): void {
    if (!this.closed || this.busy || this.#closedNotified) return;
    this.#closedNotified = true;
    this.#options.onClose?.();
  }

  #ownerClosed = (): void => this.closeImmediately();

  #context(): ImportViewContext {
    return {
      mutate: this.#mutatePage,
      readMotion: this.#options.readMotion,
      ...(this.#options.observeMotion === undefined
        ? {}
        : { observeMotion: this.#options.observeMotion }),
      own: (dispose) => this.#viewDisposers.push(dispose),
    };
  }

  #button(label: string, activate: () => void, primary = false): HTMLButtonElement {
    const button = this.#actions.createEl("button", { text: label });
    button.type = "button";
    if (primary) button.classList.add("mod-cta");
    button.addEventListener("click", activate);
    return button;
  }

  #refreshFeedback(): void {
    this.#feedback?.();
    this.#feedback = registerNativeControlFeedback(this.contentEl, this.#options);
  }

  #mutatePage = (update: () => void): void => {
    update();
    this.#refreshFeedback();
  };

  #entry(): void {
    this.#status.textContent = "";
    this.#view(() => {
      renderImportEntry(this.#body, this.#context());
      this.#button("Close", () => this.close());
      this.#button("Scan vault", () => this.#scan(), true).autofocus = true;
    });
    this.#actions.querySelector<HTMLButtonElement>(".mod-cta")?.focus();
  }

  #scan(): void {
    void this.#run(
      "Scanning vault…",
      (signal) => this.#options.service.scan(signal),
      (preview) => {
        this.#view(() => {
          const selectedPreview = renderImportPreview(
            this.#body,
            preview,
            this.#context(),
            (count) => {
              this.#actions.querySelector<HTMLButtonElement>(".mod-cta")!.disabled = count === 0;
            },
          );
          this.#button("Back", () => this.#entry());
          if (preview.sources.length > 0)
            this.#button(
              "Import handwriting",
              () => {
                const selected = selectedPreview();
                if (selected.sources.length > 0) this.#apply(selected);
              },
              true,
            );
          else this.#button("Close", () => this.close(), true);
        });
        this.#status.textContent = "Scan complete. Review the preview before importing.";
      },
    );
  }

  #apply(preview: InkImportPreview): void {
    void this.#run(
      "Importing handwriting…",
      (signal) => this.#options.service.apply(preview, signal),
      (result) => this.#result(result),
      "import",
    );
  }

  #journal(journal: InkImportJournal): void {
    this.#view(() => {
      renderImportJournal(this.#body, journal, this.#context());
      if (journal.status !== "undone" && journal.unreadable !== true) {
        this.#recoveryAction(
          "Obsidian Ink embeds",
          "Undo import",
          "Restore Obsidian Ink embeds. Keep your Inkbook files and later edits.",
          () => this.#confirm(journal, "undo"),
        );
        this.#recoveryAction(
          "Original source files",
          "Clean up originals",
          "Move verified, unused original SVGs to trash. Recovery backups stay in the vault.",
          () => this.#confirm(journal, "cleanup"),
        );
      }
      this.#button("Close", () => this.close());
    });
    this.#focusHeading();
  }

  #recoveryAction(name: string, label: string, description: string, activate: () => void): void {
    new Setting(this.#body)
      .setName(name)
      .setDesc(description)
      .addButton((button) => button.setButtonText(label).onClick(activate));
  }

  #confirm(journal: InkImportJournal, action: "undo" | "cleanup"): void {
    this.#view(() => {
      this.#body.createEl("h3", {
        text: action === "undo" ? "Restore Obsidian Ink embeds?" : "Move original SVGs to trash?",
      });
      this.#body.createEl("p", {
        text:
          action === "undo"
            ? "Restore the original note references and any originals removed by this importer. Your Inkbook files are kept, including later edits. Changed notes are checked for conflicts."
            : "Only unchanged original SVGs with no remaining references are moved to Obsidian trash. Your Inkbook files and recovery backups are kept, so backup storage is not freed.",
      });
      this.#button("Cancel", () => this.#journal(journal));
      const confirm = this.#button(
        action === "undo" ? "Restore embeds" : "Move to trash",
        () => {
          void this.#run(
            action === "undo" ? "Restoring Obsidian Ink embeds…" : "Checking original files…",
            (signal) => this.#options.service[action](journal.id, signal),
            (result) => this.#result(result, action),
            action,
          );
        },
        true,
      );
      if (action === "cleanup") confirm.classList.add("inkbook-import-danger");
    });
    this.#actions.querySelector<HTMLButtonElement>("button")?.focus();
  }

  #result(result: InkImportResult, operation: ImportOperation = "import"): void {
    this.#view(() => {
      renderImportResult(this.#body, result, this.#context(), operation);
      this.#button("View import", () => this.#journal(result.journal));
      this.#button("Done", () => this.close(), true);
    });
    this.#status.textContent = result.cancelled
      ? "Stopped. Completed changes are recorded in import history."
      : "Operation finished. Review the result and any conflicts.";
  }

  #disposeView(): void {
    for (const dispose of this.#viewDisposers.splice(0)) dispose();
  }

  #view(render: () => void): void {
    this.#finishViewMotion();
    this.#mutatePage(() => {
      this.#disposeView();
      this.#body.replaceChildren();
      this.#actions.replaceChildren();
      render();
    });
    const ownerWindow = this.#body.ownerDocument.defaultView;
    if (ownerWindow !== null) {
      this.#viewMotion = playMenuMotion(
        this.#body,
        { opacity: [0, 1] },
        effectiveTransitionDuration(this.#body, ownerWindow, "fallback"),
      );
    }
  }

  #finishViewMotion(): void {
    this.#viewMotion?.();
    this.#viewMotion = undefined;
    this.#body.style.removeProperty("opacity");
  }

  #focusHeading(): void {
    const target = this.#body.querySelector<HTMLElement>("h3") ?? this.#status;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest", behavior: "instant" });
  }

  #pending(status: string, controller: AbortController, operation: PendingImportOperation): void {
    this.#status.textContent = status;
    this.#view(() => {
      const pending = renderImportStatus(this.#body, status, operation, this.#context());
      this.#button("Stop", () => {
        controller.abort();
        this.#status.textContent = "Stopping after the current safe step…";
        pending.stop();
        this.#actions.querySelector<HTMLButtonElement>("button")!.disabled = true;
      }).focus();
    });
  }

  async #run<T>(
    status: string,
    operation: (signal: AbortSignal) => Promise<T>,
    complete: (value: T) => void,
    kind: PendingImportOperation = "scan",
  ): Promise<void> {
    if (this.#operation !== undefined || this.closed || this.closing) return;
    const controller = new AbortController();
    this.#operation = controller;
    this.#pending(status, controller, kind);
    this.#body.setAttribute("aria-busy", "true");
    try {
      const result = await operation(controller.signal);
      if (!this.closed && !this.closing) complete(result);
    } catch {
      if (!this.closed && !this.closing) this.#failure(controller.signal.aborted, kind);
    } finally {
      this.#operation = undefined;
      this.#notifyClosed();
      this.#body.removeAttribute("aria-busy");
      if (!this.closed && !this.closing) {
        this.#refreshFeedback();
        this.#focusHeading();
      }
    }
  }

  #failure(cancelled: boolean, operation: PendingImportOperation): void {
    this.#view(() => {
      this.#body.createEl("h3", {
        text: cancelled ? "Operation stopped" : "The operation could not finish",
      });
      this.#body.createEl("p", {
        text:
          operation === "scan"
            ? "Your files are unchanged. Go back to scan again, or close this window and try later."
            : "Some changes may already be complete. Go to Settings → Inkbook → Import → Import history to review or undo this run before retrying.",
      });
      this.#button("Back", () => this.#entry());
      this.#button("Close", () => this.close(), true);
    });
    this.#status.textContent = cancelled
      ? operation === "scan"
        ? "Stopped. Your files are unchanged."
        : "Stopped. Check import history for completed changes."
      : "The operation could not finish.";
  }
}
