import { ButtonComponent, SettingGroup } from "obsidian";
import { registerNativeControlFeedback } from "../../menus/feedback/native-control-feedback";
import { createSettingsWriteError, SettingsWriteFeedback } from "../settings-write-feedback";
import { configureFontLibraryButton } from "./font-library-button";
import { friendlyFontVariant } from "./font-import-view";
import { mutateFontLibraryDialog, type FontLibrarySettingsOptions } from "./font-library-options";

interface FontFamilyEditorOptions extends FontLibrarySettingsOptions {
  readonly family: string;
  readonly back: () => void;
  readonly saved: () => void;
  readonly addVariants: () => void;
  readonly draftName?: string;
}

/** Edits one stable family without exposing identity or assignment controls. */
export class FontFamilyEditor {
  readonly #root: HTMLFormElement;
  readonly #name: HTMLInputElement;
  readonly #save: HTMLButtonElement;
  readonly #status: HTMLElement;
  readonly #error: ReturnType<typeof createSettingsWriteError>;
  readonly #writes: SettingsWriteFeedback;
  readonly #feedback: () => void;
  #busy = false;
  #disposed = false;

  public constructor(
    container: HTMLElement,
    private readonly options: FontFamilyEditorOptions,
  ) {
    const { t } = options.localization;
    const faces = options.library.list().filter((face) => face.family === options.family);
    this.#root = container.createEl("form", { cls: "inkbook-font-family-editor" });
    this.#root.setAttribute(
      "aria-label",
      t("fonts.editNamed", { name: faces[0]?.displayName ?? "" }),
    );
    this.#writes = new SettingsWriteFeedback(t);
    this.#error = createSettingsWriteError(this.#root, options);
    let name!: HTMLInputElement;
    new SettingGroup(this.#root).addSetting((row) => {
      row.setName(t("fonts.pickerName"));
      row.addText((text) => {
        text.setValue(options.draftName ?? faces[0]?.displayName ?? "");
        name = text.inputEl;
        name.setAttribute("aria-label", t("fonts.pickerName"));
        name.maxLength = 128;
        name.required = true;
        text.onChange(() => {
          this.#error.set("");
          this.#save.disabled = this.#busy || !name.value.trim();
        });
      });
    });
    this.#name = name;
    name.addEventListener("keydown", this.#onNameKeyDown);
    this.#error.associate(name);
    new SettingGroup(this.#root).addSetting((row) => {
      row.settingEl.dataset.inkbookSettingIdentity = "font-library-add";
      row.setName(t("fonts.addVariants"));
      row.setDesc([...new Set(faces.map((face) => friendlyFontVariant(face, t)))].join(" · "));
      row.addButton((button) =>
        configureFontLibraryButton(button, "plus", t("fonts.addVariants"), options.addVariants),
      );
    });
    this.#status = this.#root.createDiv({ cls: "inkbook-font-library-status" });
    this.#status.setAttribute("role", "status");
    const actions = this.#root.createDiv({ cls: "inkbook-font-import-navigation" });
    configureFontLibraryButton(
      new ButtonComponent(actions),
      "arrow-left",
      t("fonts.backToLibrary"),
      options.back,
    );
    this.#save = configureFontLibraryButton(
      new ButtonComponent(actions),
      "check",
      t("fonts.save"),
      () => this.#root.requestSubmit(),
    );
    this.#save.disabled = !name.value.trim();
    this.#root.addEventListener("submit", this.#submit);
    this.#feedback = registerNativeControlFeedback(this.#root, options);
    name.focus();
    name.select();
  }

  readonly #onNameKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    this.#root.requestSubmit();
  };

  readonly #submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.#busy || this.#disposed) return;
    const { t } = this.options.localization;
    const name = this.#name.value.trim();
    if (!name || name.length > 128) {
      this.#error.set(t("fonts.invalidName"));
      this.#name.focus();
      return;
    }
    this.#setBusy(true);
    void this.#writes
      .run(
        "font-name",
        async () => {
          await this.options.library.renameFamily(this.options.family, name);
          this.options.changed();
        },
        {
          error: (message) => this.#error.set(message),
          restore: () => undefined,
          failureMessage: t("fonts.actionFailure"),
          saved: this.options.saved,
        },
      )
      .finally(() => {
        if (this.#disposed) return;
        this.#setBusy(false);
        this.#name.focus();
      });
  };

  #setBusy(busy: boolean): void {
    mutateFontLibraryDialog(this.options, () => {
      this.#busy = busy;
      this.#root.setAttribute("aria-busy", String(busy));
      this.#status.textContent = busy ? this.options.localization.t("fonts.busy") : "";
      for (const control of this.#root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "input, button",
      ))
        control.disabled = busy;
    });
  }

  public get draftName(): string {
    return this.#name.value;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#writes.dispose();
    this.#feedback();
    this.#error.dispose();
    this.#root.removeEventListener("submit", this.#submit);
    this.#name.removeEventListener("keydown", this.#onNameKeyDown);
    this.#root.remove();
  }
}
