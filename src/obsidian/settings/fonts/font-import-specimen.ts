import { getTransitionDuration } from "../../../rendering/motion/transitions";
import type { PreparedLibraryFontFace } from "../../fonts/font-import-staging";
import { playMenuMotion } from "../../menus/feedback/menu-motion";
import { observeEffectiveMotion } from "../../runtime/effective-motion";
import type { FontLibrarySettingsOptions } from "./font-library-options";
import { FontSettingsPreview } from "./font-settings-preview";

/** Prepares one native specimen and reveals it only in the mounted review. */
export class FontImportSpecimen {
  public readonly element: HTMLElement;
  readonly #sample: HTMLElement;
  readonly #status: HTMLElement;
  readonly #preview: FontSettingsPreview<PreparedLibraryFontFace>;
  readonly #releaseMotion: () => void;
  #face: PreparedLibraryFontFace | undefined;
  #reveal = false;
  #reduced = false;
  #stopFade: (() => void) | undefined;

  public constructor(
    root: HTMLElement,
    private readonly options: FontLibrarySettingsOptions,
  ) {
    const { t } = options.localization;
    this.element = root.ownerDocument.createElement("div");
    this.element.className = "inkbook-font-import-specimen";
    this.element.setAttribute("role", "region");
    this.element.setAttribute("aria-label", t("fonts.preview"));
    this.#status = this.element.createDiv({ cls: "inkbook-font-import-specimen-status" });
    this.#status.setAttribute("role", "status");
    this.#sample = this.element.createDiv({ cls: "inkbook-font-import-specimen-sample" });
    this.#sample.hidden = true;
    this.#sample.createDiv({ cls: "inkbook-font-import-glyphs", text: t("fonts.specimenGlyphs") });
    this.#sample.createEl("p", { text: t("fonts.specimenText") });
    this.#preview = new FontSettingsPreview<PreparedLibraryFontFace>(
      this.#sample,
      { scheduler: options.scheduler, resource: (face) => face.resource },
      (publish) => {
        publish();
        this.#status.textContent = "";
        this.#reveal = true;
        this.reveal();
      },
    );
    this.#releaseMotion = observeEffectiveMotion(
      root,
      options.readMotion,
      (reduced) => {
        this.#reduced = reduced;
        if (reduced) this.#finishFade();
      },
      options.observeMotion,
    );
  }

  public show(face: PreparedLibraryFontFace): void {
    if (this.#face === face) return;
    this.#face = face;
    this.#reveal = false;
    this.#finishFade();
    const { t } = this.options.localization;
    this.#status.textContent = t("fonts.previewLoading");
    void this.#preview.show(face).catch(() => {
      if (this.#face !== face) return;
      this.#status.textContent = t("fonts.previewFailure");
      this.#face = undefined;
    });
  }

  public reveal(): void {
    if (!this.#reveal || !this.element.isConnected) return;
    this.#reveal = false;
    if (this.#reduced) return;
    this.#stopFade = playMenuMotion(
      this.#sample,
      { opacity: [0, 1] },
      getTransitionDuration("fallback"),
      () => this.#finishFade(),
    );
  }

  #finishFade(): void {
    this.#stopFade?.();
    this.#stopFade = undefined;
    this.#sample.style.removeProperty("opacity");
  }

  public clear(): void {
    this.#face = undefined;
    this.#reveal = false;
    this.#finishFade();
    this.#preview.clear();
    this.#status.textContent = "";
  }

  public dispose(): void {
    this.clear();
    this.#releaseMotion();
    this.#preview.dispose();
    this.element.remove();
  }
}
