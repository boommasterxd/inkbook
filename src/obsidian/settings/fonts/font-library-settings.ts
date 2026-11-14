import { SettingGroup, setIcon, setTooltip, type Setting } from "obsidian";
import type { LibraryFontFace } from "../../fonts/vault-font-library";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import { renderImportCompletion } from "../import/import-completion-illustration";
import { createSettingsLayoutMotion } from "../settings-layout-motion";
import { refreshSettingsView } from "../settings-view-refresh";
import { createSettingsWriteError, SettingsWriteFeedback } from "../settings-write-feedback";
import { FontLibraryPreview } from "./font-library-preview";
import { FontImportWizard } from "./font-import-wizard";
import { FontFamilyEditor } from "./font-family-editor";
import { configureFontLibraryButton } from "./font-library-button";
import { friendlyFontVariant } from "./font-import-view";
import { mutateFontLibraryDialog, type FontLibrarySettingsOptions } from "./font-library-options";

const PAGE_SIZE = 8;

/** Mounts a bounded library directly in a dialog body, independently of a setting row. */
export function mountFontLibraryContent(
  container: HTMLElement,
  options: FontLibrarySettingsOptions,
): () => void {
  const content = new FontLibraryContent(container, options);
  return () => content.dispose();
}

class FontLibraryContent {
  readonly #options: FontLibrarySettingsOptions;
  readonly #root: HTMLElement;
  readonly #controls: HTMLElement;
  readonly #status: HTMLElement;
  readonly #success: HTMLElement;
  readonly #retry: HTMLButtonElement;
  readonly #error: ReturnType<typeof createSettingsWriteError>;
  readonly #layout: ReturnType<typeof createSettingsLayoutMotion>;
  #feedback: ReturnType<typeof registerNativeControlFeedback> | undefined;
  readonly #preview: FontLibraryPreview;
  readonly #writes: SettingsWriteFeedback;
  readonly #state = { page: 0 };
  #wizard: FontImportWizard | undefined;
  #editor: FontFamilyEditor | undefined;
  #disposed = false;
  #busy = false;
  #removal: AbortController | undefined;
  #retryAction: (() => void) | undefined;
  #successDisposers: Array<() => void> = [];

  public constructor(container: HTMLElement, options: FontLibrarySettingsOptions) {
    this.#options = options;
    const { t } = options.localization;
    this.#root = container.createDiv({ cls: "inkbook-font-library-content" });
    const outcomes = this.#root.createDiv({ cls: "inkbook-font-library-outcomes" });
    this.#status = outcomes.createDiv({ cls: "inkbook-font-library-status" });
    this.#status.setAttribute("role", "status");
    this.#success = outcomes.createDiv({ cls: "inkbook-font-library-success" });
    this.#success.hidden = true;
    this.#success.setAttribute("role", "status");
    this.#error = createSettingsWriteError(outcomes, options);
    const retryActions = outcomes.createDiv({ cls: "inkbook-dialog-actions" });
    this.#retry = retryActions.createEl("button", {
      cls: "clickable-icon inkbook-font-library-icon-button",
    });
    this.#retry.type = "button";
    this.#retry.setAttribute("aria-label", t("host.recovery.retry"));
    setIcon(this.#retry, "rotate-ccw");
    setTooltip(this.#retry, t("host.recovery.retry"));
    this.#retry.hidden = true;
    this.#error.associate(this.#retry);
    this.#retry.addEventListener("click", this.#retryLastAction);
    this.#controls = this.#root.createDiv({ cls: "inkbook-font-library-controls" });
    this.#writes = new SettingsWriteFeedback(t);
    this.#layout = createSettingsLayoutMotion(
      this.#root,
      options.readMotion,
      options.observeMotion,
    );
    this.#preview = new FontLibraryPreview(options, () =>
      this.#error.set(t("fonts.previewFailure")),
    );
    this.#render();
  }

  #render(): void {
    if (this.#disposed) return;
    mutateFontLibraryDialog(this.#options, () => {
      this.#preview.clear();
      const { localization } = this.#options;
      const { t } = localization;
      const focused = this.#controls.ownerDocument.activeElement;
      const hadFocus = this.#controls.contains(focused);
      const fonts = this.#options.library.list();
      refreshSettingsView(this.#controls, () => {
        this.#controls.replaceChildren();
        if (fonts.length > 0)
          new SettingGroup(this.#controls).addSetting((row) => {
            row.settingEl.dataset.inkbookSettingIdentity = "font-library-add";
            row.setName(t("fonts.add"));
            addFontImportButton(row, t("fonts.add"), () => this.#startImport());
          });
        const list = this.#controls.createDiv({ cls: "inkbook-font-library-list" });
        renderFontPage(list, this.#options, this.#state, fonts, {
          add: () => this.#startImport(),
          preview: (face, row, button) => {
            this.#error.set("");
            if (!this.#success.hidden) this.#layout.mutate(() => this.#clearSuccess());
            this.#preview.toggle(face, row, button);
          },
          remove: (face) => void this.#remove(face),
          edit: (face) => this.#startEdit(face),
          page: (delta) => {
            mutateFontLibraryDialog(this.#options, () => {
              this.#preview.clear();
              this.#state.page += delta;
              this.#layout.mutate(() => this.#render());
            });
          },
        });
      });
      this.#setBusy(this.#busy);
      this.#feedback?.();
      this.#feedback = registerNativeControlFeedback(this.#root, this.#options);
      if (
        hadFocus &&
        focused?.isConnected === false &&
        !this.#controls.contains(this.#controls.ownerDocument.activeElement)
      ) {
        this.#controls.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
      }
    });
  }

  #changed = (): void => {
    if (!this.#disposed) this.#preview.clear();
    this.#options.changed();
  };

  async #remove(face: LibraryFontFace): Promise<void> {
    if (this.#disposed || this.#busy || this.#removal !== undefined) return;
    const focused = this.#root.ownerDocument.activeElement;
    const lifetime = new AbortController();
    this.#removal = lifetime;
    const confirmed = await this.#options.confirmRemove(face, lifetime.signal);
    this.#removal = undefined;
    if (this.#disposed || lifetime.signal.aborted) return;
    if (confirmed) this.#run(() => this.#options.library.remove(face.id).then(this.#changed));
    else if (focused !== null && focused.isConnected && "focus" in focused)
      (focused as HTMLElement).focus();
  }

  #run(action: () => Promise<void>): void {
    if (this.#disposed || this.#busy) return;
    const { t } = this.#options.localization;
    const fromRetry = this.#root.ownerDocument.activeElement === this.#retry;
    this.#retryAction = () => this.#run(action);
    mutateFontLibraryDialog(this.#options, () => {
      this.#retry.hidden = true;
      this.#clearSuccess();
      this.#status.textContent = t("fonts.busy");
      this.#setBusy(true);
    });
    void this.#writes
      .run(
        "fonts",
        async () => {
          await action();
          return undefined;
        },
        {
          error: (message) => {
            this.#error.set(message);
            this.#retry.hidden = message === "";
          },
          restore: () => undefined,
          failureMessage: t("fonts.actionFailure"),
          saved: () => {
            this.#retryAction = undefined;
          },
        },
      )
      .finally(() => {
        if (this.#disposed) return;
        mutateFontLibraryDialog(this.#options, () => {
          this.#status.textContent = "";
          this.#busy = false;
          this.#layout.mutate(() => this.#render());
          if (fromRetry) {
            if (!this.#retry.hidden) this.#retry.focus();
            else this.#controls.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
          }
        });
      });
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#controls.setAttribute("aria-busy", String(busy));
    if (!busy) return;
    for (const control of this.#controls.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
      "button, select",
    )) {
      control.disabled = true;
    }
  }

  #retryLastAction = (): void => this.#retryAction?.();

  #startImport(family?: string, faceId?: string): void {
    if (this.#busy || this.#wizard || this.#disposed) return;
    mutateFontLibraryDialog(this.#options, () => {
      const draftName = this.#editor?.draftName;
      this.#editor?.dispose();
      this.#editor = undefined;
      this.#preview.clear();
      this.#clearSuccess();
      this.#error.set("");
      this.#feedback?.();
      this.#feedback = undefined;
      this.#controls.replaceChildren();
      this.#wizard = new FontImportWizard(this.#controls, {
        ...this.#options,
        ...(family === undefined ? {} : { family }),
        back: () => this.#returnFromImport(family, draftName, faceId),
        imported: () => {
          this.#changed();
          if (this.#disposed) return;
          this.#returnFromImport(family, draftName, faceId);
          this.#showSuccess();
        },
      });
    });
  }

  #returnToLibrary(faceId?: string): void {
    mutateFontLibraryDialog(this.#options, () => {
      this.#editor?.dispose();
      this.#editor = undefined;
      this.#wizard?.dispose();
      this.#wizard = undefined;
      this.#layout.mutate(() => this.#render());
      const row =
        faceId === undefined
          ? undefined
          : this.#controls.querySelector<HTMLElement>(
              `[data-inkbook-setting-identity="font:${faceId}"]`,
            );
      (row ?? this.#controls).querySelector<HTMLButtonElement>("button")?.focus();
    });
  }

  #startEdit(face: LibraryFontFace, draftName?: string): void {
    if (this.#busy || this.#disposed) return;
    mutateFontLibraryDialog(this.#options, () => {
      this.#preview.clear();
      this.#clearSuccess();
      this.#error.set("");
      this.#retry.hidden = true;
      this.#retryAction = undefined;
      this.#feedback?.();
      this.#feedback = undefined;
      this.#editor?.dispose();
      this.#controls.replaceChildren();
      this.#layout.mutate(() => {
        this.#editor = new FontFamilyEditor(this.#controls, {
          ...this.#options,
          family: face.family,
          ...(draftName === undefined ? {} : { draftName }),
          back: () => this.#returnToLibrary(face.id),
          saved: () => {
            if (!this.#disposed) this.#returnToLibrary(face.id);
          },
          addVariants: () => this.#startImport(face.family, face.id),
        });
      });
    });
  }

  #returnFromImport(family?: string, draftName?: string, faceId?: string): void {
    mutateFontLibraryDialog(this.#options, () => {
      this.#wizard?.dispose();
      this.#wizard = undefined;
      const faces = this.#options.library.list();
      const face =
        faces.find((item) => item.id === faceId && item.family === family) ??
        faces.find((item) => item.family === family);
      if (face === undefined) this.#returnToLibrary();
      else this.#startEdit(face, draftName);
    });
  }

  #showSuccess(): void {
    mutateFontLibraryDialog(this.#options, () => {
      this.#layout.mutate(() => {
        this.#success.hidden = false;
        renderImportCompletion(this.#success, {
          readMotion: this.#options.readMotion,
          ...(this.#options.observeMotion === undefined
            ? {}
            : { observeMotion: this.#options.observeMotion }),
          own: (dispose) => this.#successDisposers.push(dispose),
        });
        this.#success.createEl("p", { text: this.#options.localization.t("fonts.importSuccess") });
      });
    });
  }

  #clearSuccess(): void {
    if (this.#success.hidden && this.#success.childNodes.length === 0) return;
    mutateFontLibraryDialog(this.#options, () => {
      for (const dispose of this.#successDisposers.splice(0)) dispose();
      this.#success.hidden = true;
      this.#success.replaceChildren();
    });
  }

  public dispose(): void {
    this.#disposed = true;
    this.#removal?.abort();
    this.#retryAction = undefined;
    this.#clearSuccess();
    this.#preview.dispose();
    this.#wizard?.dispose();
    this.#wizard = undefined;
    this.#editor?.dispose();
    this.#editor = undefined;
    this.#retry.removeEventListener("click", this.#retryLastAction);
    this.#feedback?.();
    this.#writes.dispose();
    this.#error.dispose();
    this.#layout.dispose();
    this.#root.remove();
  }
}

interface FontPageActions {
  readonly add: () => void;
  readonly preview: (face: LibraryFontFace, row: HTMLElement, button: HTMLButtonElement) => void;
  readonly remove: (face: LibraryFontFace) => void;
  readonly edit: (face: LibraryFontFace) => void;
  readonly page: (delta: number) => void;
}

function renderFontPage(
  container: HTMLElement,
  options: FontLibrarySettingsOptions,
  state: { page: number },
  fonts: readonly LibraryFontFace[],
  actions: FontPageActions,
): void {
  const { t } = options.localization;
  const pages = Math.max(1, Math.ceil(fonts.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const group = new SettingGroup(container);
  if (fonts.length === 0)
    group.addSetting((row) => {
      row.settingEl.classList.add("inkbook-font-library-empty-row");
      row.settingEl.dataset.inkbookSettingIdentity = "font-library-empty";
      row.setName(t("fonts.empty"));
      addFontImportButton(row, t("fonts.add"), actions.add);
    });
  for (const face of fonts.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    group.addSetting((row) => {
      row.settingEl.dataset.inkbookSettingIdentity = `font:${face.id}`;
      row.settingEl.classList.add("inkbook-font-library-font-row");
      row.controlEl.classList.add("inkbook-dialog-actions");
      row.setName(face.displayName).setDesc(friendlyFontVariant(face, t));
      row.addButton((button) => {
        configureFontLibraryButton(
          button,
          "pencil",
          t("fonts.editNamed", { name: face.displayName }),
          () => actions.edit(face),
        );
      });
      row.addButton((button) => {
        configureFontLibraryButton(
          button,
          "eye",
          t("fonts.previewNamed", { name: face.displayName }),
          () => actions.preview(face, row.settingEl, button.buttonEl),
        );
        button.buttonEl.setAttribute("aria-expanded", "false");
      });
      row.addButton((button) => {
        configureFontLibraryButton(
          button,
          "trash-2",
          t("fonts.removeNamed", { name: face.displayName }),
          () => actions.remove(face),
        );
        button.buttonEl.dataset.warning = "true";
      });
    });
  }
  if (fonts.length <= PAGE_SIZE) return;
  group.addSetting((row) => {
    row.settingEl.dataset.inkbookSettingIdentity = "font-library-pagination";
    row.controlEl.classList.add("inkbook-dialog-actions");
    row.setName(t("fonts.page", { page: state.page + 1, pages }));
    row.addButton((button) => {
      button
        .setIcon("chevron-left")
        .setTooltip(t("fonts.previous"))
        .setDisabled(state.page === 0)
        .onClick(() => actions.page(-1));
      button.buttonEl.classList.add("clickable-icon", "inkbook-font-library-icon-button");
      button.buttonEl.setAttribute("aria-label", t("fonts.previous"));
    });
    row.addButton((button) => {
      button
        .setIcon("chevron-right")
        .setTooltip(t("fonts.next"))
        .setDisabled(state.page >= pages - 1)
        .onClick(() => actions.page(1));
      button.buttonEl.classList.add("clickable-icon", "inkbook-font-library-icon-button");
      button.buttonEl.setAttribute("aria-label", t("fonts.next"));
    });
  });
}

function addFontImportButton(row: Setting, label: string, add: () => void): void {
  row.addButton((button) => {
    configureFontLibraryButton(button, "plus", label, add);
  });
}
