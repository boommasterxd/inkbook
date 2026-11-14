import type { MessageKey } from "../../../domain/localization";
import {
  applyFontPreview,
  loadNativeFontPreview,
  type NativeFontPreview,
} from "../../fonts/native-font-preview";
import { FontImportError } from "../../fonts/vault-font-library";
import { FontFamilyFaceConflictError, fontLibraryChoices } from "../../fonts/font-library-families";
import type { LibraryFontFace } from "../../fonts/vault-font-library";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import { createSettingsLayoutMotion } from "../settings-layout-motion";
import { createSettingsWriteError } from "../settings-write-feedback";
import { mutateFontLibraryDialog, type FontLibrarySettingsOptions } from "./font-library-options";
import { FontImportSelection } from "./font-import-selection";
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
  readonly #input: HTMLInputElement;
  readonly #status: HTMLElement;
  readonly #error: ReturnType<typeof createSettingsWriteError>;
  readonly #layout: ReturnType<typeof createSettingsLayoutMotion>;
  readonly #selection: FontImportSelection;
  #feedback: (() => void) | undefined;
  #view: FontImportViewHandle | undefined;
  #step: 1 | 2 | 3 = 1;
  #name = "";
  #target: string | undefined;
  #previewId: string | undefined;
  #preview: NativeFontPreview | undefined;
  #previewAbort: AbortController | undefined;
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
    this.#layout = createSettingsLayoutMotion(
      this.#root,
      options.readMotion,
      options.observeMotion,
    );
    this.#render(true);
  }

  #render(focus = false): void {
    if (this.#disposed) return;
    mutateFontLibraryDialog(this.options, () => {
      this.#clearPreview();
      this.#layout.mutate(() => {
        this.#content.replaceChildren();
        const faces = this.options.library.list();
        const choices = fontLibraryChoices(faces);
        this.#view = renderFontImportView(
          this.#content,
          {
            step: this.#step,
            files: this.#selection.files,
            busy: this.#busy,
            name: choices.find((choice) => choice.value === this.#target)?.label ?? this.#name,
            ...(this.#target ? { targetFamily: this.#target } : {}),
            ...(this.#previewId ? { previewId: this.#previewId } : {}),
            existingChoices: choices,
            fixedFamily: this.options.family !== undefined,
          },
          {
            chooseFiles: () => this.#input.click(),
            filesSelected: (files) => this.#selectFiles(files),
            removeFile: this.#removeFile,
            nameChanged: (name) => {
              this.#name = name;
              this.#view!.primary.disabled = !name.trim();
            },
            familyChanged: (family) => {
              this.#target = family;
              this.#error.set("");
              this.#render();
            },
            previewChanged: (id) => {
              this.#previewId = id;
              this.#render();
            },
            back: () => this.#back(),
            next: () => this.#next(),
            confirm: () => {
              void this.#commit();
            },
          },
          this.options.localization,
        );
        this.#feedback?.();
        this.#feedback = registerNativeControlFeedback(this.#view.root, this.options);
        if (focus) this.#view.heading.focus();
        if (this.#step === 2 && !this.#busy) void this.#loadPreview();
      });
    });
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
    this.#selection.remove(id);
    if (this.#previewId === id) this.#previewId = undefined;
    if (this.#selection.files.length === 0) {
      this.#name = "";
      this.#target = this.options.family;
    }
    this.#error.set("");
    this.#render();
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
    if (this.#busy || this.#selection.files.length === 0) return;
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
    if (this.#busy || this.#disposed) return;
    this.#setBusy(true, "fonts.importing");
    try {
      const faces = await this.options.library.commitImport(
        this.#selection.files,
        {
          displayName:
            this.options.library.list().find((face) => face.family === this.#target)?.displayName ??
            this.#name.trim(),
          ...(this.#target ? { family: this.#target } : {}),
        },
        this.#selection.signal,
      );
      this.options.imported(faces);
    } catch (error) {
      if (!this.#disposed) this.#error.set(this.#message(error));
    } finally {
      if (!this.#disposed) {
        this.#setBusy(false);
        this.#view?.primary.focus();
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

  async #loadPreview(): Promise<void> {
    const target = this.#view?.preview;
    const face =
      this.#selection.files.find((file) => file.id === this.#previewId) ?? this.#selection.files[0];
    if (!target || !face) return;
    const abort = new AbortController();
    this.#previewAbort = abort;
    try {
      const scheduler =
        typeof this.options.scheduler === "function"
          ? this.options.scheduler(target.ownerDocument.defaultView)
          : this.options.scheduler;
      const preview = await loadNativeFontPreview(face.resource, {
        document: target.ownerDocument,
        scheduler,
        signal: abort.signal,
      });
      if (abort.signal.aborted || this.#disposed) {
        preview?.dispose();
        return;
      }
      this.#preview = preview;
      if (preview) mutateFontLibraryDialog(this.options, () => applyFontPreview(target, preview));
    } catch {
      if (!abort.signal.aborted && !this.#disposed)
        this.#error.set(this.options.localization.t("fonts.previewFailure"));
    }
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

  #clearPreview(): void {
    this.#previewAbort?.abort();
    this.#previewAbort = undefined;
    this.#preview?.dispose();
    this.#preview = undefined;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#clearPreview();
    this.#selection.dispose();
    this.#feedback?.();
    this.#input.removeEventListener("change", this.#selected);
    this.#error.dispose();
    this.#layout.dispose();
    this.#root.remove();
  }
}
