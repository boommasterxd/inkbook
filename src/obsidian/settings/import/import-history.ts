import type { Setting } from "obsidian";

import { isReducedMotion } from "../../../rendering/motion/transitions";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";
import { createSettingsDisclosure } from "../settings-disclosure";
import { SettingsPanelMotion } from "../settings-panel-motion";
import type { InkImportSettingsAccess } from "./import-access";
import { renderImportHistory } from "./import-view";

export interface ImportHistoryOptions extends NativeControlFeedbackOptions {
  readonly access: InkImportSettingsAccess;
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
  #disposed = false;
  #selectedId: string | undefined;

  public constructor(setting: Setting, options: ImportHistoryOptions) {
    this.#options = options;
    setting.settingEl.replaceChildren();
    setting.settingEl.classList.add(
      "inkbook-settings-import-history",
      "inkbook-settings-validation-surface",
    );
    this.#disclosure = createSettingsDisclosure(setting.settingEl, {
      title: "Import history",
      description: "Review previous imports, restore Obsidian Ink embeds or clean up originals.",
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
    this.#releaseChanges = options.access.subscribe(() => void this.#load());
    setting.settingEl.ownerDocument.defaultView?.addEventListener("pagehide", this.dispose);
    options.signal?.addEventListener("abort", this.dispose, { once: true });
    if (options.signal?.aborted === true) this.dispose();
  }

  #toggle = (): void => {
    if (this.#disposed) return;
    this.#expanded = !this.#expanded;
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
    this.#status.textContent = "Loading import history…";
    this.#status.removeAttribute("data-inkbook-history-error");
    this.#results
      .querySelector(".inkbook-import-history-retry")
      ?.setAttribute("aria-disabled", "true");
    try {
      const history = await this.#options.access.history(
        this.#results.ownerDocument.defaultView,
        request.signal,
      );
      if (!this.#current(request)) return;
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
            void this.#options.access
              .open(this.#results.ownerDocument.defaultView, journal, this.#lifetime.signal)
              .catch(() => this.#failure());
          },
          { mutate: this.#mutate, selectedId: focusedRun ?? this.#selectedId },
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
          : `${history.length} saved import${history.length === 1 ? "" : "s"}.`;
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
    this.#status.textContent =
      "Import history could not be loaded. Close any running import and try again.";
    this.#status.setAttribute("data-inkbook-history-error", "true");
    if (this.#results.querySelector(".inkbook-import-history-retry") !== null) return;
    this.#mutate(() => {
      const retry = this.#results.createEl("button", {
        cls: "inkbook-import-history-retry",
        text: "Try again",
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
