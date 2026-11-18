import type { MessageKey } from "../../../domain/localization";
import {
  inspectFontImport,
  type FontImportSelection as ImportTarget,
} from "../../fonts/font-import-plan";
import { FontImportError } from "../../fonts/vault-font-library";
import { FontFamilyFaceConflictError, fontLibraryChoices } from "../../fonts/font-library-families";
import type { LibraryFontFace } from "../../fonts/vault-font-library";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import { createSettingsLayoutMotion } from "../settings-layout-motion";
import { createSettingsWriteError } from "../settings-write-feedback";
import { refreshSettingsView } from "../settings-view-refresh";
import { mutateFontLibraryDialog, type FontLibrarySettingsOptions } from "./font-library-options";
import { FontImportSelection } from "./font-import-selection";
import { FontImportSpecimen } from "./font-import-specimen";
import { renderFontImportView, type FontImportViewHandle } from "./font-import-view";

interface FontImportWizardOptions extends FontLibrarySettingsOptions {
  readonly back: () => void;
  readonly imported: (faces: readonly LibraryFontFace[]) => void;
  readonly family?: string;
}

/** Coordinates guided review, one preview and an explicit final admission. */
export class FontImportWizard {
  readonly #root: HTMLElement;
  readonly #content: HTMLElement;
  readonly #footer: HTMLElement;
  readonly #input: HTMLInputElement;
  readonly #status: HTMLElement;
  readonly #error: ReturnType<typeof createSettingsWriteError>;
  readonly #layout: ReturnType<typeof createSettingsLayoutMotion>;
  readonly #selection: FontImportSelection;
  #feedback: (() => void) | undefined;
  #footerFeedback: (() => void) | undefined;
  #view: FontImportViewHandle | undefined;
  #step: 1 | 2 | 3 = 1;
  #name = "";
  #target: string | undefined;
  #previewId: string | undefined;
  #specimen: FontImportSpecimen | undefined;
  #targetSelection: ImportTarget = { displayName: "" };
  #reviewBlocked = false;
  #busy = false;
  #disposed = false;

  public constructor(
    container: HTMLElement,
    private readonly options: FontImportWizardOptions,
  ) {
    this.#target = options.family;
    this.#selection = new FontImportSelection(options.library);
    this.#root = container.createDiv();
    this.#input = this.#root.createEl("input", { type: "file" });
    this.#input.accept = ".ttf,.otf,.woff,.woff2";
    this.#input.multiple = true;
    this.#input.hidden = true;
    this.#input.setAttribute("aria-label", options.localization.t("fonts.chooseFiles"));
    this.#input.addEventListener("change", this.#selected);
    this.#status = this.#root.createDiv({ cls: "inkbook-font-library-status" });
    this.#status.setAttribute("role", "status");
    this.#content = this.#root.createDiv();
    this.#content.setAttribute("role", "group");
    this.#content.setAttribute("aria-label", options.localization.t("fonts.import"));
    this.#error = createSettingsWriteError(this.#root, options);
    this.#error.associate(this.#content);
    this.#footer = (options.importFooter ?? this.#root).createDiv({
      cls: "inkbook-font-import-footer-content",
    });
    this.#layout = createSettingsLayoutMotion(
      this.#root,
      options.readMotion,
      options.observeMotion,
    );
    this.#render(true);
  }

  #chooseFiles = (): void => {
    if (this.#disposed || this.#busy || this.#step !== 1) return;
    this.#content.querySelector<HTMLButtonElement>(".inkbook-font-import-dropzone")?.focus();
    this.#input.click();
  };

  #render(focus = false): void {
    if (this.#disposed) return;
    mutateFontLibraryDialog(this.options, () => {
      this.#layout.mutate(() => {
        if (focus) this.#renderStep();
        else refreshSettingsView(this.#content, () => this.#renderStep());
        if (focus) this.#view?.heading.focus();
      });
    });
  }

  #renderStep(): void {
    this.#content.replaceChildren();
    this.#footer.replaceChildren();
    if (this.#step === 2) this.#showSpecimen();
    else this.#specimen?.clear();
    const faces = this.#step === 1 ? [] : this.options.library.list();
    this.#view = renderFontImportView(
      this.#content,
      this.#footer,
      {
        step: this.#step,
        files: this.#selection.files,
        busy: this.#busy,
        name: this.#displayName(faces),
        ...(this.#target === undefined ? {} : { targetFamily: this.#target }),
        ...(this.#previewId === undefined ? {} : { previewId: this.#previewId }),
        ...(this.#step !== 2 || this.#specimen === undefined
          ? {}
          : { specimen: this.#specimen.element }),
        existingChoices: this.#step === 2 ? fontLibraryChoices(faces) : [],
        fixedFamily: this.options.family !== undefined,
      },
      {
        chooseFiles: this.#chooseFiles,
        filesSelected: (files) => this.#selectFiles(files),
        removeFile: this.#removeFile,
        nameChanged: (name) => {
          this.#name = name;
          this.#targetSelection = { displayName: name.trim() };
          this.#updatePrimary();
        },
        familyChanged: this.#familyChanged,
        previewChanged: (id) => {
          this.#previewId = id;
          this.#showSpecimen();
        },
        preparePreview: () => this.#showSpecimen(),
        back: () => this.#back(),
        next: () => this.#next(),
        confirm: () => void this.#commit(),
      },
      this.options.localization,
    );
    this.#updateReview(faces);
    this.#feedback?.();
    this.#feedback = registerNativeControlFeedback(this.#view.root, this.options);
    this.#footerFeedback?.();
    this.#footerFeedback = registerNativeControlFeedback(this.#footer, this.options);
    this.#specimen?.reveal();
  }

  #displayName(faces: readonly LibraryFontFace[]): string {
    return faces.find((face) => face.family === this.#target)?.displayName ?? this.#name;
  }

  #familyChanged = (family: string | undefined): void => {
    this.#target = family;
    const faces = this.options.library.list();
    const nameInput = this.#view?.nameInput;
    if (nameInput !== undefined) {
      nameInput.disabled = family !== undefined;
      nameInput.value = this.#displayName(faces);
    }
    mutateFontLibraryDialog(this.options, () => {
      this.#error.set("");
      this.#updateReview(faces);
    });
  };

  #updateReview(faces: readonly LibraryFontFace[]): void {
    if (this.#step === 1) return;
    this.#targetSelection = {
      displayName: this.#displayName(faces).trim(),
      ...(this.#target === undefined ? {} : { family: this.#target }),
    };
    const review = inspectFontImport(this.#selection.files, faces, this.#targetSelection);
    this.#reviewBlocked = review.conflicts.size > 0 || review.error !== undefined;
    this.#view?.showReview(review);
    this.#updatePrimary();
  }

  #updatePrimary(): void {
    if (this.#view !== undefined)
      this.#view.primary.disabled =
        this.#busy || this.#reviewBlocked || this.#targetSelection.displayName === "";
  }

  #showSpecimen(): void {
    const face =
      this.#selection.files.find((file) => file.id === this.#previewId) ?? this.#selection.files[0];
    if (face === undefined || this.#busy) return;
    this.#specimen ??= new FontImportSpecimen(this.#root, this.options);
    this.#specimen.show(face);
  }

  #selected = (): void => {
    const files = [...(this.#input.files ?? [])];
    this.#input.value = "";
    this.#selectFiles(files);
  };

  #selectFiles(files: readonly File[]): void {
    if (this.#busy || this.#disposed || files.length === 0) return;
    void this.#prepare(files);
  }

  #removeFile = (id: string): void => {
    const index = this.#selection.files.findIndex((face) => face.id === id);
    const row = this.#content.querySelector(
      `[data-inkbook-setting-identity="font-import-file:${id}"]`,
    );
    const restoreFocus = row?.contains(this.#content.ownerDocument.activeElement) === true;
    this.#selection.remove(id);
    if (this.#previewId === id) this.#previewId = undefined;
    if (this.#selection.files.length === 0) {
      this.#name = "";
      this.#target = this.options.family;
      this.#step = 1;
    }
    this.#error.set("");
    this.#render();
    if (restoreFocus) {
      const next = this.#selection.files[Math.min(index, this.#selection.files.length - 1)];
      const identity = next === undefined ? "font-import-upload" : `font-import-file:${next.id}`;
      this.#content
        .querySelector<HTMLElement>(`[data-inkbook-setting-identity="${identity}"] button`)
        ?.focus({ preventScroll: true });
    }
  };

  async #prepare(files: readonly File[]): Promise<void> {
    this.#setBusy(true, "fonts.filesChecking");
    try {
      await this.#selection.add(files);
      if (this.#disposed) return;
      this.#name ||= this.#selection.files[0]?.familyName ?? "";
      const existing = this.options.library
        .list()
        .find((face) => face.id === this.#selection.files[0]?.id);
      this.#target ??= existing?.family;
    } catch (error) {
      if (!this.#disposed) this.#error.set(this.#message(error));
    } finally {
      if (!this.#disposed) {
        this.#setBusy(false);
        if (this.#view?.primary.disabled)
          this.#view.root.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
        else this.#view?.primary.focus();
      }
    }
  }

  #next(): void {
    if (this.#busy || this.#view?.primary.disabled !== false) return;
    if (
      this.#step === 2 &&
      this.#target === undefined &&
      (!this.#name.trim() || this.#name.length > 128)
    ) {
      this.#error.set(this.options.localization.t("fonts.invalidName"));
      this.#view?.nameInput?.focus();
      return;
    }
    this.#error.set("");
    this.#step = this.#step === 1 ? 2 : 3;
    this.#render(true);
  }

  #back(): void {
    if (this.#busy) return;
    if (this.#step === 1) {
      this.options.back();
      return;
    }
    this.#error.set("");
    this.#step = this.#step === 3 ? 2 : 1;
    this.#render(true);
  }

  async #commit(): Promise<void> {
    if (this.#busy || this.#disposed || this.#view?.primary.disabled !== false) return;
    const target = this.#targetSelection;
    this.#setBusy(true, "fonts.importing");
    try {
      const faces = await this.options.library.commitImport(
        this.#selection.files,
        target,
        this.#selection.signal,
      );
      this.options.imported(faces);
    } catch (error) {
      if (!this.#disposed) this.#error.set(this.#message(error));
    } finally {
      if (!this.#disposed) {
        this.#setBusy(false);
        const view = this.#view;
        if (view?.primary.disabled === false) view.primary.focus();
        else view?.heading.focus();
      }
    }
  }

  #setBusy(busy: boolean, message?: MessageKey): void {
    mutateFontLibraryDialog(this.options, () => {
      this.#busy = busy;
      if (busy) this.#error.set("");
      this.#status.textContent = message ? this.options.localization.t(message) : "";
      this.#render();
    });
  }

  #message(error: unknown): string {
    const { t } = this.options.localization;
    if (error instanceof FontFamilyFaceConflictError) return t("fonts.faceConflict");
    if (!(error instanceof FontImportError)) return t("fonts.failure");
    const messages: Record<FontImportError["code"], MessageKey> = {
      "invalid-font": "fonts.invalidFile",
      "native-rejected": "fonts.nativeRejected",
      "file-limit": "fonts.filesTooLarge",
      "staging-limit": "fonts.stagingLimit",
      "library-full": "fonts.libraryFull",
      "unavailable-family": "fonts.unavailableFamily",
      "duplicate-family": "fonts.duplicateFamily",
      "invalid-name": "fonts.invalidName",
      "invalid-prepared": "fonts.failure",
    };
    return t(messages[error.code]);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#specimen?.dispose();
    this.#selection.dispose();
    this.#feedback?.();
    this.#footerFeedback?.();
    this.#footer.remove();
    this.#input.removeEventListener("change", this.#selected);
    this.#error.dispose();
    this.#layout.dispose();
    this.#root.remove();
  }
}
