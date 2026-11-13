import { setIcon } from "obsidian";
import type { LibraryFontFace } from "../../fonts/vault-font-library";
import { SettingsPanelMotion } from "../settings-panel-motion";
import type { FontLibrarySettingsOptions } from "./font-library-options";
import { FontSettingsPreview } from "./font-settings-preview";

interface PreviewTarget {
  readonly face: LibraryFontFace;
  readonly row: HTMLElement;
  readonly button: HTMLButtonElement;
}

interface ActivePreview extends PreviewTarget {
  readonly panel: HTMLElement;
  readonly motion: SettingsPanelMotion;
  readonly font: FontSettingsPreview;
  closing: boolean;
}

let nextPreview = 0;

/** Keeps one inline preview and its font alive through collapse, then admits the next. */
export class FontLibraryPreview {
  #active: ActivePreview | undefined;
  #pending: PreviewTarget | undefined;
  #draining = false;
  #disposed = false;

  public constructor(
    private readonly options: FontLibrarySettingsOptions,
    private readonly onError: () => void,
  ) {}

  public toggle(face: LibraryFontFace, row: HTMLElement, button: HTMLButtonElement): void {
    if (this.#disposed) return;
    const same =
      this.#pending?.face.id === face.id ||
      (this.#pending === undefined && this.#active?.face.id === face.id && !this.#active.closing);
    this.#setButton(this.#pending?.button, false);
    this.#pending = same ? undefined : { face, row, button };
    this.#setButton(this.#pending?.button, true);
    if (this.#active) this.#close(this.#active);
    else this.#start();
  }

  #start(): void {
    if (this.#draining) return;
    const target = this.#pending;
    this.#pending = undefined;
    if (!target || this.#disposed || !target.row.isConnected) return;
    this.#setButton(target.button, true);
    const panel = target.row.createDiv({ cls: "inkbook-font-library-preview" });
    panel.id = `inkbook-font-preview-${++nextPreview}`;
    panel.hidden = true;
    panel.setAttribute("aria-busy", "true");
    panel.setAttribute("role", "region");
    panel.setAttribute(
      "aria-label",
      this.options.localization.t("fonts.previewNamed", {
        name: target.face.displayName,
      }),
    );
    target.button.setAttribute("aria-controls", panel.id);
    const sample = panel.createEl("p", {
      cls: "inkbook-font-sample",
      text: this.options.localization.t("fonts.sample"),
    });
    const motion = new SettingsPanelMotion(
      panel,
      this.options.readMotion,
      this.options.observeMotion,
    );
    const font = new FontSettingsPreview(sample, this.options, (update) => {
      if (this.#active !== active || active.closing) return;
      update();
      panel.setAttribute("aria-busy", "false");
      motion.setExpanded(true);
    });
    const active: ActivePreview = { ...target, panel, motion, font, closing: false };
    this.#active = active;
    void font.show(target.face).catch(() => {
      if (this.#active !== active || active.closing || this.#disposed) return;
      this.#close(active);
      this.onError();
    });
  }

  #close(active: ActivePreview): void {
    if (active.closing) return;
    active.closing = true;
    active.font.cancelPending();
    this.#setButton(active.button, false);
    active.motion.setExpanded(false, () => {
      if (this.#active !== active) return;
      this.#retire(active);
    });
  }

  #retire(active: ActivePreview): void {
    this.#active = undefined;
    this.#draining = true;
    const settled = active.font.settled;
    this.#release(active);
    // FontFace.load cannot be aborted; its previous admission must finish first.
    void settled.then(() => {
      this.#draining = false;
      this.#start();
    });
  }

  #setButton(button: HTMLButtonElement | undefined, expanded: boolean): void {
    if (!button) return;
    button.setAttribute("aria-expanded", String(expanded));
    setIcon(button, expanded ? "eye-off" : "eye");
  }

  #release(active: ActivePreview): void {
    active.motion.dispose();
    active.font.dispose();
    active.panel.remove();
    active.button.removeAttribute("aria-controls");
    this.#setButton(active.button, false);
  }

  public clear(): void {
    this.#setButton(this.#pending?.button, false);
    this.#pending = undefined;
    const active = this.#active;
    if (active) this.#retire(active);
  }

  public dispose(): void {
    this.#disposed = true;
    this.clear();
  }
}
