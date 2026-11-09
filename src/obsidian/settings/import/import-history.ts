import type { InkImportJournal } from "../../import/types";
import type { Localization } from "../../../domain/localization";
import type { Setting } from "obsidian";

import { isReducedMotion } from "../../../rendering/motion/transitions";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";
import { createSettingsDisclosure } from "../settings-disclosure";
import { SettingsPanelMotion } from "../settings-panel-motion";
import type { InkImportSettingsAccess } from "./import-access";
import { renderImportHistory } from "./import-view";

export interface ImportHistoryState {
  expanded?: boolean;
  selectedId?: string;
  page?: number;
  history?: readonly InkImportJournal[];
}

export interface ImportHistoryOptions extends NativeControlFeedbackOptions {
  readonly access: InkImportSettingsAccess;
  readonly state?: ImportHistoryState;
  readonly localization: Localization;
  readonly signal?: AbortSignal | undefined;
}

/** Lazy history shares the existing settings disclosure and journaled recovery entry. */
export class ImportHistory {
  readonly #options: ImportHistoryOptions;
  readonly #disclosure: ReturnType<typeof createSettingsDisclosure>;
  readonly #motion: SettingsPanelMotion;
  readonly #status: HTMLElement;
  readonly #results: HTMLElement;
  readonly #releaseChanges: () => void;
  readonly #lifetime = new AbortController();
  #feedback: ReturnType<typeof registerNativeControlFeedback> | undefined;
  #request: AbortController | undefined;
  #expanded = false;
  #useCachedHistory = true;
  #disposed = false;
  #selectedId: string | undefined;

  public constructor(setting: Setting, options: ImportHistoryOptions) {
    this.#options = options;
    this.#selectedId = options.state?.selectedId;
    setting.settingEl.replaceChildren();
    setting.settingEl.classList.add(
      "inkbook-settings-import-history",
      "inkbook-settings-validation-surface",
    );
    this.#disclosure = createSettingsDisclosure(setting.settingEl, {
      title: this.#options.localization.t("import.history"),
      description: this.#options.localization.t("import.historyDescription"),
      expanded: false,
      panelId: `inkbook-import-history-${setting.settingEl.ownerDocument.defaultView?.crypto.randomUUID()}`,
      readMotion: options.readMotion,
      ...(options.observeMotion === undefined ? {} : { observeMotion: options.observeMotion }),
    });
    this.#status = this.#disclosure.content.createEl("p", {
      cls: "inkbook-import-history-status",
    });
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    this.#results = this.#disclosure.content.createDiv();
    this.#motion = new SettingsPanelMotion(
      this.#disclosure.panel,
      options.readMotion,
      options.observeMotion,
    );
    this.#disclosure.trigger.addEventListener("click", this.#toggle);
    this.#releaseChanges = options.access.subscribe(() => {
      if (options.state !== undefined) delete options.state.history;
      void this.#load();
    });
    setting.settingEl.ownerDocument.defaultView?.addEventListener("pagehide", this.dispose);
    options.signal?.addEventListener("abort", this.dispose, { once: true });
    if (options.signal?.aborted === true) this.dispose();
    else if (options.state?.expanded === true) this.#toggle();
  }

  #toggle = (): void => {
    if (this.#disposed) return;
    this.#expanded = !this.#expanded;
    if (this.#options.state !== undefined) this.#options.state.expanded = this.#expanded;
    this.#disclosure.trigger.setAttribute("aria-expanded", String(this.#expanded));
    this.#disclosure.setExpanded(
      this.#expanded,
      isReducedMotion(
        this.#options.readMotion(),
        this.#results.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)")
          .matches,
      ),
    );
    this.#motion.setExpanded(this.#expanded);
    if (this.#expanded) void this.#load();
    else this.#request?.abort();
  };

  async #load(): Promise<void> {
    if (this.#disposed || !this.#expanded) return;
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.#results.setAttribute("aria-busy", "true");
    this.#status.textContent = this.#options.localization.t("import.historyLoading");
    this.#status.removeAttribute("data-inkbook-history-error");
    this.#results
      .querySelector(".inkbook-import-history-retry")
      ?.setAttribute("aria-disabled", "true");
    try {
      const cached = this.#useCachedHistory ? this.#options.state?.history : undefined;
      this.#useCachedHistory = false;
      const history =
        cached ??
        (await this.#options.access.history(
          this.#results.ownerDocument.defaultView,
          request.signal,
        ));
      if (!this.#current(request)) return;
      if (this.#options.state !== undefined) this.#options.state.history = history;
      const focusedRun = this.#results.ownerDocument.activeElement?.closest<HTMLElement>(
        "[data-inkbook-import-run]",
      )?.dataset.inkbookImportRun;
      const retryFocused = this.#results.ownerDocument.activeElement?.matches(
        ".inkbook-import-history-retry",
      );
      this.#mutate(() => {
        this.#results.replaceChildren();
        renderImportHistory(
          this.#results,
          history,
          (journal) => {
            this.#selectedId = journal.id;
            if (this.#options.state !== undefined) this.#options.state.selectedId = journal.id;
            void this.#options.access
              .open(this.#results.ownerDocument.defaultView, journal, this.#lifetime.signal)
              .catch(() => this.#failure());
          },
          {
            mutate: this.#mutate,
            selectedId: focusedRun ?? this.#selectedId,
            localization: this.#options.localization,
            ...(this.#options.state === undefined ? {} : { state: this.#options.state }),
          },
        );
        if (focusedRun !== undefined) {
          [...this.#results.querySelectorAll<HTMLButtonElement>("[data-inkbook-import-run]")]
            .find((button) => button.dataset.inkbookImportRun === focusedRun)
            ?.focus({ preventScroll: true });
        }
        if (retryFocused === true) this.#disclosure.trigger.focus({ preventScroll: true });
      });
      this.#status.textContent =
        history.length === 0
          ? ""
          : this.#options.localization.t(
              this.#options.localization.plural(history.length) === "one"
                ? "import.historyCountOne"
                : "import.historyCountOther",
              { count: this.#options.localization.number(history.length) },
            );
    } catch {
      if (this.#current(request)) this.#failure();
    } finally {
      if (this.#request === request) {
        this.#request = undefined;
        this.#results.removeAttribute("aria-busy");
        this.#results
          .querySelector(".inkbook-import-history-retry")
          ?.removeAttribute("aria-disabled");
      }
    }
  }

  #current(request: AbortController): boolean {
    return (
      !this.#disposed && this.#expanded && this.#request === request && !request.signal.aborted
    );
  }

  #failure(): void {
    if (this.#disposed) return;
    this.#status.textContent = this.#options.localization.t("import.historyFailure");
    this.#status.setAttribute("data-inkbook-history-error", "true");
    if (this.#results.querySelector(".inkbook-import-history-retry") !== null) return;
    this.#mutate(() => {
      const retry = this.#results.createEl("button", {
        cls: "inkbook-import-history-retry",
        text: this.#options.localization.t("import.retry"),
      });
      retry.type = "button";
      retry.addEventListener("click", () => {
        if (this.#request === undefined) void this.#load();
      });
    });
  }

  #mutate = (update: () => void): void => {
    this.#feedback?.();
    this.#motion.updateContent(update);
    this.#feedback = registerNativeControlFeedback(this.#results, this.#options);
  };

  public dispose = (): void => {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifetime.abort();
    this.#request?.abort();
    this.#releaseChanges();
    this.#feedback?.();
    this.#disclosure.trigger.removeEventListener("click", this.#toggle);
    this.#results.ownerDocument.defaultView?.removeEventListener("pagehide", this.dispose);
    this.#options.signal?.removeEventListener("abort", this.dispose);
    this.#disclosure.dispose();
    this.#motion.dispose();
  };
}
