import type { Localization, MessageKey } from "../../../domain/localization";
import { bindElementLanguage } from "../../../rendering/localization/element-language";
import { Setting, type App, type WorkspaceLeaf } from "obsidian";

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
  renderImportImpact,
  renderImportJournal,
  renderImportPreview,
  renderImportResult,
  type ImportOperation,
  type ImportViewContext,
} from "./import-view";
import { renderImportStatus, type PendingImportOperation } from "./import-status";
import { renderImportFailure } from "./import-failure";
import type { ImportViewState } from "./import-findings";
import { mountImportDialogLayout } from "./import-dialog-layout";
import { finishImportNoteHandoff, openImportNote } from "./open-import-note";

export interface InkImportDialogOptions {
  readonly localization: Localization;
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
  readonly closeOwnerOnNoteOpen?: (() => void) | undefined;
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
  #compactLayout!: MediaQueryList;
  #feedback: ReturnType<typeof registerNativeControlFeedback> | undefined;
  #updatingPage = false;
  #viewMotion: (() => void) | undefined;
  #releaseMotion: (() => void) | undefined;
  #returnFocus: HTMLElement | undefined;
  #closedNotified = false;
  #renderView: (() => void) | undefined;
  #viewState: ImportViewState = { findings: new Map() };
  #releaseLocalization: (() => void) | undefined;
  #statusKey: MessageKey | undefined;
  #openingNote = false;
  #openedNote: WorkspaceLeaf | undefined;

  public constructor(app: App, options: InkImportDialogOptions) {
    const { readMotion, workScheduler, observeMotion, localization } = options;
    super(app, readMotion, workScheduler, observeMotion, localization);
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
    this.setTitle(this.#options.localization.t("import.title"));
    this.#compactLayout = mountImportDialogLayout(this, this.#lifetime.signal);
    const active = this.contentEl.ownerDocument.activeElement;
    if (active !== null && "focus" in active) this.#returnFocus = active as HTMLElement;
    this.#status = this.contentEl.createDiv({
      cls: "inkbook-import-status-message inkbook-menu-visually-hidden",
    });
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
    this.#feedback = registerNativeControlFeedback(this.contentEl, this.#options);
    const releaseLanguage = bindElementLanguage(this.modalEl, this.#options.localization);
    const unsubscribe = this.#options.localization.subscribe(this.#refreshLanguage);
    this.#releaseLocalization = () => {
      unsubscribe();
      releaseLanguage();
    };
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
    this.#feedback = undefined;
    this.#finishViewMotion();
    this.#releaseMotion?.();
    this.#releaseLocalization?.();
    this.#renderView = undefined;
    this.#viewState = { findings: new Map() };
    super.onClose();
    if (this.#openedNote !== undefined) {
      void finishImportNoteHandoff(this.app.workspace, this.#openedNote, this.#options).then(
        this.#notifyClosed,
        this.#notifyClosed,
      );
      return;
    }
    if (this.#returnFocus?.isConnected === true) this.#returnFocus.focus();
    this.#notifyClosed();
  }

  #notifyClosed = (): void => {
    if (!this.closed || this.busy || this.#closedNotified) return;
    this.#closedNotified = true;
    this.#options.onClose?.();
  };

  #ownerClosed = (): void => this.closeImmediately();

  #context(): ImportViewContext {
    return {
      compactLayout: this.#compactLayout,
      localization: this.#options.localization,
      state: this.#viewState,
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

  #mutatePage = (update: () => void): void => {
    if (this.#updatingPage) return update();
    this.#updatingPage = true;
    try {
      update();
      this.#feedback?.refresh();
    } finally {
      this.#updatingPage = false;
    }
  };

  #entry(): void {
    this.#statusKey = undefined;
    this.#status.textContent = "";
    this.#view(() => {
      renderImportEntry(this.#body, this.#context());
      this.#button(this.#options.localization.t("host.dialog.close"), () => this.close());
      this.#button(
        this.#options.localization.t("import.scan"),
        () => this.#scan(),
        true,
      ).autofocus = true;
    });
    this.#actions.querySelector<HTMLButtonElement>(".mod-cta")?.focus();
  }

  #scan(): void {
    void this.#run(
      "import.scanPending",
      (signal) => this.#options.service.scan(signal),
      (preview) => {
        this.#view(() => this.#review(preview));
        this.#announce(
          preview.sources.length === 0 ? "import.scanEmptyStatus" : "import.scanComplete",
        );
      },
    );
  }

  #review(preview: InkImportPreview): void {
    const localization = this.#options.localization;
    if (preview.sources.length === 0) {
      renderImportPreview(this.#body, preview, this.#context());
      this.#button(localization.t("import.back"), () => this.#entry());
      this.#button(localization.t("import.scanAgain"), () => this.#scan(), true);
      return;
    }
    const updateImpact = renderImportImpact(this.#actions, localization);
    this.#button(localization.t("import.back"), () => this.#entry());
    const button = this.#button(
      localization.t("import.import"),
      () => {
        const selected = selectedPreview();
        if (selected.sources.length > 0) this.#apply(selected);
      },
      true,
    );
    const selectedPreview = renderImportPreview(
      this.#body,
      preview,
      this.#context(),
      (count, notes) => {
        updateImpact(count, notes);
        button.disabled = count === 0;
      },
    );
  }

  #apply(preview: InkImportPreview): void {
    void this.#run(
      "import.importPending",
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
          this.#options.localization.t("import.embeds"),
          this.#options.localization.t("import.undo"),
          this.#options.localization.t("import.undoDescription"),
          () => this.#confirm(journal, "undo"),
        );
        this.#recoveryAction(
          this.#options.localization.t("import.originals"),
          this.#options.localization.t("import.cleanup"),
          this.#options.localization.t("import.cleanupDescription"),
          () => this.#confirm(journal, "cleanup"),
        );
      }
      this.#button(this.#options.localization.t("host.dialog.close"), () => this.close());
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
        text:
          action === "undo"
            ? this.#options.localization.t("import.undoConfirm")
            : this.#options.localization.t("import.cleanupConfirm"),
      });
      this.#body.createEl("p", {
        text:
          action === "undo"
            ? this.#options.localization.t("import.undoConfirmDescription")
            : this.#options.localization.t("import.cleanupConfirmDescription"),
      });
      this.#button(this.#options.localization.t("import.cancel"), () => this.#journal(journal));
      const confirm = this.#button(
        action === "undo"
          ? this.#options.localization.t("import.restore")
          : this.#options.localization.t("import.trash"),
        () => {
          void this.#run(
            action === "undo" ? "import.undoPending" : "import.cleanupPending",
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
      renderImportResult(this.#body, result, this.#context(), operation, (path) => {
        void this.#openNote(path);
      });
      this.#button(this.#options.localization.t("import.view"), () =>
        this.#journal(result.journal),
      );
      this.#button(this.#options.localization.t("import.done"), () => this.close(), true);
    });
    this.#announce(result.cancelled ? "import.stoppedStatus" : "import.finishedStatus");
  }

  async #openNote(path: string): Promise<void> {
    const owner = this.contentEl.ownerDocument.defaultView;
    if (owner === null || this.closed || this.closing || this.#openingNote) return;
    this.#openingNote = true;
    const view = this.#renderView;
    this.#announce("import.openNotePending");
    try {
      const leaf = await openImportNote(this.app, path, owner);
      if (this.#renderView !== view || this.closed || this.closing) return;
      if (leaf === undefined) this.#announce("import.openNoteFailure");
      else {
        this.#openedNote = leaf;
        this.close();
      }
    } catch {
      if (this.#renderView === view && !this.closed && !this.closing)
        this.#announce("import.openNoteFailure");
    } finally {
      this.#openingNote = false;
    }
  }

  #announce(key: MessageKey): void {
    this.#statusKey = key;
    this.#status.textContent = this.#options.localization.t(key);
    this.#status.classList.toggle("inkbook-menu-visually-hidden", key !== "import.openNoteFailure");
  }

  #refreshLanguage = (): void => {
    if (this.closed || this.closing || this.#renderView === undefined) return;
    const controls = [...this.contentEl.querySelectorAll<HTMLElement>("button, input, h3")];
    const focused = controls.indexOf(this.contentEl.ownerDocument.activeElement as HTMLElement);
    const scroll = this.#body.scrollTop;
    this.setTitle(this.#options.localization.t("import.title"));
    this.#view(this.#renderView, true);
    if (this.#statusKey !== undefined) this.#announce(this.#statusKey);
    this.#body.scrollTop = scroll;
    const target = this.contentEl.querySelectorAll<HTMLElement>("button, input, h3")[focused];
    if (target?.tagName === "H3") target.tabIndex = -1;
    target?.focus({ preventScroll: true });
  };

  #disposeView(): void {
    for (const dispose of this.#viewDisposers.splice(0)) dispose();
  }

  #view(render: () => void, preserve = false): void {
    this.#renderView = render;
    if (!preserve) {
      this.#viewState = { findings: new Map() };
      this.#status.classList.add("inkbook-menu-visually-hidden");
      if (
        this.#statusKey === "import.openNotePending" ||
        this.#statusKey === "import.openNoteFailure"
      ) {
        this.#statusKey = undefined;
        this.#status.textContent = "";
      }
    }
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
    this.#body.scrollTop = 0;
  }

  #pending(
    status: MessageKey,
    controller: AbortController,
    operation: PendingImportOperation,
  ): void {
    this.#announce(status);
    this.#view(() => {
      const pending = renderImportStatus(
        this.#body,
        this.#options.localization.t(status),
        operation,
        this.#context(),
      );
      const button = this.#button(this.#options.localization.t("import.stop"), () => {
        controller.abort();
        this.#announce("import.stoppingStatus");
        pending.stop();
        this.#actions.querySelector<HTMLButtonElement>("button")!.disabled = true;
      });
      if (controller.signal.aborted) {
        pending.stop();
        button.disabled = true;
      } else button.focus();
    });
  }

  async #run<T>(
    status: MessageKey,
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
    } catch (error) {
      if (!this.closed && !this.closing) this.#failure(controller.signal.aborted, kind, error);
    } finally {
      this.#operation = undefined;
      this.#notifyClosed();
      this.#body.removeAttribute("aria-busy");
      if (!this.closed && !this.closing) this.#focusHeading();
    }
  }

  #failure(cancelled: boolean, operation: PendingImportOperation, error: unknown): void {
    this.#statusKey = undefined;
    this.#view(() => {
      this.#status.textContent = renderImportFailure(
        this.#body,
        cancelled,
        operation,
        error,
        this.#options.localization,
      );
      this.#button(this.#options.localization.t("import.back"), () => this.#entry());
      this.#button(this.#options.localization.t("host.dialog.close"), () => this.close(), true);
    });
  }
}
