import { Platform, setIcon } from "obsidian";
import type { Localization } from "../../domain/localization";

/** Owns the reading and focus order for the import settings, chooser and preview. */
export class ImageImportReviewLayout {
  public readonly previews: HTMLElement;
  public readonly figure: HTMLElement;
  public readonly controls: HTMLElement;

  public constructor(
    body: HTMLElement,
    private readonly surface: HTMLElement,
  ) {
    const review = body.createDiv({ cls: "inkbook-image-import-review" });
    this.previews = review.createDiv({ cls: "inkbook-image-import-preview-column" });
    this.figure = this.previews.createEl("figure", { cls: "inkbook-image-import-figure" });
    this.figure.hidden = true;
    this.controls = review.createDiv({ cls: "inkbook-image-import-controls" });
  }

  public addPlacement(localization: Localization) {
    const field = this.controls.createDiv({ cls: "inkbook-image-import-placement-field" });
    field.hidden = true;
    const label = field.createEl("label", {
      cls: "inkbook-menu-toggle-row inkbook-image-import-placement",
    });
    label.createSpan({ text: localization.t("images.pageWidthLocked") });
    const control = label.createSpan({ cls: "inkbook-menu-switch" });
    const input = control.createEl("input", { type: "checkbox" });
    control.createSpan({ cls: "inkbook-menu-switch-track" }).createSpan({
      cls: "inkbook-menu-switch-thumb",
    });
    const hint = field.createEl("p", { text: localization.t("images.pageWidthLockedHint") });
    hint.id = `inkbook-image-placement-${crypto.randomUUID()}`;
    input.setAttribute("aria-describedby", hint.id);
    return { field, input };
  }

  public addCaption(localization: Localization) {
    const caption = this.figure.createEl("figcaption");
    const details = caption.createSpan();
    const hint = caption.createSpan({ text: localization.t("images.previewHint") });
    hint.hidden = true;
    return { details, hint };
  }

  public addResizeWarning() {
    const element = this.controls.createEl("p", {
      cls: "inkbook-image-import-resize-warning inkbook-settings-validation-visual",
      attr: { role: "status", "aria-live": "polite" },
    });
    element.hidden = true;
    const icon = element.createSpan({
      cls: "inkbook-image-import-warning-icon",
      attr: { "aria-hidden": "true" },
    });
    setIcon(icon, "triangle-alert");
    return { element, text: element.createSpan() };
  }

  public setReview(mode: "single-page" | "standard" | "pdf-pages" | undefined): void {
    if (this.surface.dataset.review === mode) return;
    if (mode !== undefined) this.surface.dataset.review = mode;
    else delete this.surface.dataset.review;
    if (!Platform.isPhone) return;
    const ready = mode !== undefined;
    this.surface.classList.toggle("inkbook-phone-image-review", ready);
    if (ready) {
      this.previews.before(this.controls);
      this.previews.append(this.figure);
    } else {
      this.previews.after(this.controls);
      this.previews.prepend(this.figure);
    }
  }
}
