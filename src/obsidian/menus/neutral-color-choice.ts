import type { StyleControl } from "./editor-menu-types";
import { setTooltip, type Keymap } from "obsidian";
import {
  menuTranslator,
  updateMenuText,
  type MenuLocalizationOptions,
} from "./localized-menu-text";
import { installMenuEscapeScope } from "./menu-escape-scope";
import { observeMenuMotionPreference, playMenuMotion } from "./feedback/menu-motion";
import { effectiveTransitionDuration } from "../runtime/effective-motion";
import { createChoicePreview } from "./style-choice-preview";

type ColorControl = Extract<StyleControl, { kind: "choice" }>;
interface NeutralColorChoiceOptions extends MenuLocalizationOptions {
  readonly keymap?: Pick<Keymap, "pushScope" | "popScope"> | undefined;
  readonly mutateLayout?: ((update: () => void) => void) | undefined;
  readonly onChange: (controlId: string, value: boolean | number | string) => void;
  readonly registerChoiceRestore?: (id: string, restore: (value: string | null) => void) => void;
  readonly registerCleanup?: ((cleanup: () => void) => void) | undefined;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}
const MODES = ["theme-text", "#000000FF", "#FFFFFFFF"] as const;
const LABELS = ["editor.option.theme-text", "editor.option.black", "editor.option.white"] as const;
let nextChoice = 0;

/** One palette cell contains the automatic and two explicit neutral colors. */
export class NeutralColorChoice {
  public readonly trigger: HTMLButtonElement;
  readonly #body: HTMLElement;
  readonly #panel: HTMLElement;
  readonly #options: NeutralColorChoiceOptions;
  readonly #buttons: HTMLButtonElement[];
  readonly #description: HTMLElement;
  #value: string | null;
  #displayedColor: string | undefined;
  #stopMotion: (() => void) | undefined;
  #releaseMotion: (() => void) | undefined;
  #releaseEscape: (() => void) | undefined;
  #disposed = false;

  public constructor(
    field: HTMLElement,
    body: HTMLElement,
    control: ColorControl,
    options: NeutralColorChoiceOptions,
  ) {
    this.#body = body;
    this.#options = options;
    this.#value = control.value;
    this.trigger = body.createEl("button", {
      cls: "inkbook-menu-choice inkbook-neutral-color-choice",
    });
    this.trigger.type = "button";
    this.trigger.dataset.value = "theme-text";
    this.trigger.setAttribute("aria-expanded", "false");
    this.#panel = field.createDiv({ cls: "inkbook-neutral-color-options" });
    this.#panel.id = `inkbook-neutral-colors-${++nextChoice}`;
    this.#panel.hidden = true;
    this.#panel.inert = true;
    this.#panel.setAttribute("role", "group");
    this.trigger.setAttribute("aria-controls", this.#panel.id);
    this.#buttons = MODES.map((value) => {
      const button = this.#panel.createEl("button", { cls: "inkbook-menu-choice" });
      button.type = "button";
      button.dataset.value = value;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setValue(value);
        options.onChange(control.id, value);
        this.#setOpen(false);
        this.trigger.focus({ preventScroll: true });
      });
      return button;
    });
    this.#description = field.createEl("p", {
      cls: "inkbook-neutral-color-description",
    });
    this.#description.id = `${this.#panel.id}-description`;
    this.trigger.setAttribute("aria-describedby", this.#description.id);
    this.#panel.setAttribute("aria-describedby", this.#description.id);
    this.trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#setOpen(this.#panel.hidden === true);
    });
    field.ownerDocument.addEventListener("keydown", this.#onKeyDown, true);
    field.addEventListener("focusout", this.#onFocusOut);
    options.registerCleanup?.(() => {
      this.#disposed = true;
      this.#releaseEscape?.();
      this.#stopMotion?.();
      this.#releaseMotion?.();
      field.ownerDocument.removeEventListener("keydown", this.#onKeyDown, true);
      field.removeEventListener("focusout", this.#onFocusOut);
    });
    options.registerChoiceRestore?.(control.id, (value) => this.setValue(value));
    updateMenuText(options, () => this.#renderText());
  }

  public setValue(value: string | null): void {
    if (this.#disposed) return;
    this.#value = value;
    if (!MODES.some((mode) => mode === value)) {
      const restoreFocus = this.#panel.contains(this.#panel.ownerDocument.activeElement);
      this.#setOpen(false);
      if (restoreFocus) this.trigger.focus({ preventScroll: true });
    }
    for (const button of this.#body.querySelectorAll<HTMLButtonElement>("button[data-value]")) {
      const selected =
        button === this.trigger
          ? MODES.some((mode) => mode === value)
          : button.dataset.value === value;
      const pressed = String(selected);
      if (button.getAttribute("aria-pressed") !== pressed)
        button.setAttribute("aria-pressed", pressed);
    }
    for (const button of this.#buttons) {
      const pressed = String(button.dataset.value === value);
      if (button.getAttribute("aria-pressed") !== pressed)
        button.setAttribute("aria-pressed", pressed);
    }
    this.#renderText();
  }

  #renderText(): void {
    const t = menuTranslator(this.#options);
    const index = Math.max(
      0,
      MODES.findIndex((value) => value === this.#value),
    );
    const label = t(LABELS[index]!);
    const color = MODES[index]!;
    if (index === 0) {
      if (this.trigger.textContent !== label) this.trigger.textContent = label;
    } else if (this.#displayedColor !== color) {
      const preview = createChoicePreview(
        { ownerDocument: this.trigger.ownerDocument, renderIcon: this.#options.renderIcon },
        "color",
        color,
      );
      if (preview !== null) {
        preview.setAttribute("aria-hidden", "true");
        this.trigger.replaceChildren(preview);
      }
    }
    this.#displayedColor = color;
    const accessible = `${label}: ${t("editor.color.neutral-options")}`;
    if (this.trigger.getAttribute("aria-label") !== accessible) {
      this.trigger.setAttribute("aria-label", accessible);
      setTooltip(this.trigger, accessible, { delay: 700 });
    }
    this.#panel.setAttribute("aria-label", t("editor.color.neutral-options"));
    this.#description.textContent =
      index === 0
        ? t("editor.color.auto-description")
        : t("editor.color.fixed-description", { color: label });
    this.#buttons.forEach((button, index) => {
      button.textContent = t(LABELS[index]!);
    });
  }

  #setOpen(open: boolean): void {
    if (this.#disposed || open === !this.#panel.hidden) return;
    this.#stopMotion?.();
    this.#releaseEscape?.();
    this.#releaseEscape = undefined;
    this.#releaseMotion?.();
    this.#releaseMotion = undefined;
    const update = (): void => {
      this.#panel.hidden = !open;
      this.#panel.inert = !open;
      this.trigger.setAttribute("aria-expanded", String(open));
    };
    if (this.#options.mutateLayout !== undefined) this.#options.mutateLayout(update);
    else update();
    if (open) {
      this.#releaseEscape = installMenuEscapeScope(this.#options.keymap, this.#closeAndFocus);
      this.#releaseMotion = observeMenuMotionPreference(
        this.trigger,
        this.trigger.ownerDocument.defaultView!,
        () => {
          this.#stopMotion?.();
          this.#stopMotion = undefined;
          this.#panel.style.removeProperty("opacity");
        },
      );
      this.#stopMotion = playMenuMotion(
        this.#panel,
        { opacity: [0, 1] },
        effectiveTransitionDuration(
          this.trigger,
          this.trigger.ownerDocument.defaultView!,
          "fallback",
        ),
      );
    }
  }

  readonly #closeAndFocus = (): void => {
    this.#setOpen(false);
    this.trigger.focus({ preventScroll: true });
  };

  readonly #onFocusOut = (event: FocusEvent): void => {
    const field = this.#body.parentElement!;
    if (!field.contains(event.relatedTarget as Node | null)) this.#setOpen(false);
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as Node | null;
    if (target === this.trigger && event.key === "ArrowDown") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#setOpen(true);
      (
        this.#buttons.find((button) => button.dataset.value === this.#value) ?? this.#buttons[0]
      )?.focus();
      return;
    }
    if (this.#panel.hidden || event.key !== "Escape" || !this.#body.parentElement!.contains(target))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#closeAndFocus();
  };
}
