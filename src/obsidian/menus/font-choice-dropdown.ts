import type { StyleControl } from "./editor-menu-types";
import { FontChoicePopup } from "./font-choice-popup";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { setTooltip, type Keymap } from "obsidian";
import { installMenuEscapeScope } from "./menu-escape-scope";
import { controlLabel } from "./localized-style-labels";
import {
  menuTranslator,
  updateMenuText,
  type MenuLocalizationOptions,
} from "./localized-menu-text";

export interface FontOptionPreviewPort {
  acquire(element: HTMLElement, family: string): () => void;
}

export interface FontChoiceDropdownOptions extends MenuLocalizationOptions {
  readonly workScheduler: Pick<WorkScheduler, "requestFrame" | "cancelFrame">;
  readonly fontManagementAction?:
    | {
        readonly label: string | (() => string);
        readonly onActivate: (trigger: HTMLButtonElement) => void;
      }
    | undefined;
  readonly keymap?: Pick<Keymap, "pushScope" | "popScope"> | undefined;
  readonly fontPreviews?: FontOptionPreviewPort | undefined;
  readonly registerCleanup?: ((cleanup: () => void) => void) | undefined;
  readonly registerChoiceRestore?: (id: string, restore: (value: string | null) => void) => void;
  readonly onChange: (controlId: string, value: boolean | number | string) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

type FontControl = Extract<StyleControl, { kind: "choice" }>;
let nextDropdown = 0;

/** A select-only combobox inside the existing adaptive surface, with explicit commit. */
export function createFontChoiceDropdown(
  body: HTMLElement,
  control: FontControl,
  options: FontChoiceDropdownOptions,
): void {
  const dropdown = new FontChoiceDropdown(body, control, options);
  options.registerCleanup?.(() => dropdown.dispose());
  options.registerChoiceRestore?.(control.id, (value) => dropdown.setValue(value));
}

class FontChoiceDropdown {
  readonly #control: FontControl;
  readonly #options: FontChoiceDropdownOptions;
  readonly #body: HTMLElement;
  readonly #trigger: HTMLButtonElement;
  readonly #label: HTMLElement;
  readonly #list: HTMLElement;
  readonly #surface: HTMLElement;
  readonly #managementButton: HTMLButtonElement | undefined;
  readonly #items: HTMLElement[];
  readonly #popup: FontChoicePopup;
  readonly #previews = new Map<HTMLElement, () => void>();
  #observer: IntersectionObserver | undefined;
  #value: string | null;
  #active = 0;
  #open = false;
  #disposed = false;
  #selectedPreview: (() => void) | undefined;
  #previewFamily: string | null = null;
  #releaseEscape: (() => void) | undefined;

  public constructor(body: HTMLElement, control: FontControl, options: FontChoiceDropdownOptions) {
    this.#body = body;
    this.#control = control;
    this.#options = options;
    this.#value = control.value;
    body.classList.add("inkbook-font-dropdown");
    this.#trigger = body.createEl("button", { cls: "dropdown inkbook-font-dropdown-trigger" });
    this.#trigger.type = "button";
    this.#trigger.setAttribute("role", "combobox");
    this.#trigger.setAttribute("aria-expanded", "false");
    this.#label = this.#trigger.createSpan({ cls: "inkbook-font-dropdown-label" });
    const sizer = this.#trigger.createSpan({
      cls: "inkbook-font-dropdown-sizer",
      text: control.options.map(({ label }) => label).join("\n"),
    });
    sizer.setAttribute("aria-hidden", "true");
    this.#surface = body.createDiv({
      cls: "inkbook-font-dropdown-popup inkbook-menu-choice-palette",
    });
    this.#surface.hidden = true;
    this.#list = this.#surface.createDiv({ cls: "inkbook-font-dropdown-list" });
    this.#list.id = `inkbook-font-options-${++nextDropdown}`;
    this.#surface.id = `${this.#list.id}-popup`;
    this.#list.setAttribute("role", "listbox");
    this.#list.hidden = true;
    this.#popup = new FontChoicePopup(this.#trigger, this.#surface, options.workScheduler);
    this.#managementButton = this.#createManagementButton();
    this.#items = control.options.map((option, index) => {
      const item = this.#list.createDiv({ cls: "inkbook-font-dropdown-option" });
      item.id = `${this.#list.id}-${index}`;
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.setAttribute("aria-label", option.label);
      item.title = option.label;
      item.createSpan({ cls: "inkbook-font-dropdown-label", text: option.label });
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.#commit(index);
      });
      return item;
    });
    this.#trigger.addEventListener("click", () => this.#setOpen(!this.#open));
    body.addEventListener("focusout", (event) => {
      if (!this.#contains(event.relatedTarget as Node | null)) this.#setOpen(false);
    });
    // Registered during content creation, before the enclosing panel's Escape handler.
    body.ownerDocument.addEventListener("keydown", this.#onKeyDown, true);
    body.ownerDocument.addEventListener("pointerdown", this.#onOutsidePointer, true);
    updateMenuText(options, () => this.#renderValue());
    this.setValue(control.value);
  }

  #createManagementButton(): HTMLButtonElement | undefined {
    const action = this.#options.fontManagementAction;
    if (action === undefined) return undefined;
    const footer = this.#surface.createDiv({ cls: "inkbook-font-dropdown-footer" });
    const button = footer.createEl("button", {
      cls: "inkbook-font-dropdown-manage",
    });
    button.type = "button";
    const icon = button.createSpan({ cls: "inkbook-menu-control-icon" });
    icon.setAttribute("aria-hidden", "true");
    this.#options.renderIcon(icon, "plus");
    const text = button.createSpan({ cls: "inkbook-font-dropdown-label" });
    updateMenuText(this.#options, () => {
      const label = typeof action.label === "function" ? action.label() : action.label;
      text.textContent = label;
      button.setAttribute("aria-label", label);
      setTooltip(button, label);
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#setOpen(false);
      this.#trigger.focus({ preventScroll: true });
      action.onActivate(this.#trigger);
    });
    button.addEventListener("focusout", (event) => {
      if (!this.#contains(event.relatedTarget as Node | null)) this.#setOpen(false);
    });
    return button;
  }

  #contains(target: Node | null): boolean {
    return this.#body.contains(target) || this.#surface.contains(target);
  }

  public setValue(value: string | null): void {
    if (this.#disposed) return;
    this.#value = value;
    for (const item of this.#items)
      item.setAttribute("aria-selected", String(item.dataset.value === value));
    this.#renderValue();
    if (this.#previewFamily !== value) {
      this.#selectedPreview?.();
      this.#selectedPreview =
        value === null ? undefined : this.#options.fontPreviews?.acquire(this.#label, value);
      this.#previewFamily = value;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#setOpen(false);
    this.#disposed = true;
    this.#selectedPreview?.();
    this.#selectedPreview = undefined;
    this.#body.ownerDocument.removeEventListener("keydown", this.#onKeyDown, true);
    this.#body.ownerDocument.removeEventListener("pointerdown", this.#onOutsidePointer, true);
  }

  #renderValue(): void {
    const label =
      this.#control.options.find(({ value }) => value === this.#value)?.label ??
      this.#value ??
      menuTranslator(this.#options)("editor.style.mixed");
    this.#label.textContent = label;
    this.#trigger.title = label;
    this.#trigger.setAttribute(
      "aria-label",
      `${controlLabel(this.#options, this.#control)}: ${label}`,
    );
    this.#list.setAttribute("aria-label", controlLabel(this.#options, this.#control));
    const heading = this.#body.parentElement?.querySelector(".inkbook-menu-control-label");
    if (heading !== null && heading !== undefined)
      heading.textContent =
        this.#value === null
          ? menuTranslator(this.#options)("editor.style.mixed-label", {
              label: controlLabel(this.#options, this.#control),
            })
          : controlLabel(this.#options, this.#control);
    if (this.#value === null) delete this.#trigger.dataset.value;
    else this.#trigger.dataset.value = this.#value;
  }

  #setOpen(open: boolean): void {
    if (this.#disposed || this.#open === open) return;
    this.#open = open;
    this.#list.hidden = !open;
    this.#trigger.setAttribute("aria-expanded", String(open));
    if (!open) {
      this.#popup.close();
      this.#releaseEscape?.();
      this.#releaseEscape = undefined;
      this.#trigger.removeAttribute("aria-controls");
      this.#trigger.removeAttribute("aria-activedescendant");
      this.#observer?.disconnect();
      this.#observer = undefined;
      for (const release of this.#previews.values()) release();
      this.#previews.clear();
      return;
    }
    this.#popup.open();
    this.#releaseEscape = installMenuEscapeScope(this.#options.keymap, () => this.#setOpen(false));
    this.#trigger.setAttribute("aria-controls", this.#list.id);
    const selected = this.#items.findIndex((item) => item.dataset.value === this.#value);
    this.#activate(Math.max(0, selected));
    this.#observePreviews();
  }

  #activate(index: number): void {
    this.#active = index;
    for (const [position, item] of this.#items.entries())
      item.dataset.active = String(position === index);
    const item = this.#items[index];
    if (item === undefined) return;
    this.#trigger.setAttribute("aria-activedescendant", item.id);
    item.scrollIntoView({ block: "nearest" });
  }

  #commit(index: number): void {
    if (!this.#open) return;
    const option = this.#control.options[index];
    if (option === undefined) return;
    const changed = this.#value !== option.value;
    this.setValue(option.value);
    this.#setOpen(false);
    this.#trigger.focus({ preventScroll: true });
    if (changed) this.#options.onChange(this.#control.id, option.value);
  }

  readonly #onOutsidePointer = (event: PointerEvent): void => {
    if (event.target !== null && !this.#contains(event.target as Node)) this.#setOpen(false);
  };

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (
      event.key === "Tab" &&
      this.#open &&
      this.#trigger
        .closest(".inkbook-adaptive-panel")
        ?.getAttribute("aria-owns")
        ?.split(/\s+/)
        .includes(this.#surface.id)
    )
      return;
    if (this.#handleManagementKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.target !== this.#trigger || event.isComposing || event.ctrlKey || event.metaKey)
      return;
    if (!this.#handleKey(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  #handleManagementKey(event: KeyboardEvent): boolean {
    if (!this.#open || event.isComposing || event.ctrlKey || event.metaKey) return false;
    if (event.target === this.#managementButton) {
      if (event.key === "Enter") {
        this.#managementButton.click();
        return true;
      }
      if (event.key === "Escape") {
        this.#setOpen(false);
        this.#trigger.focus({ preventScroll: true });
        return true;
      }
      if (event.key === "Tab" && event.shiftKey) {
        this.#trigger.focus({ preventScroll: true });
        return true;
      }
      if (event.key === "Tab") this.#setOpen(false);
    }
    if (
      event.target === this.#trigger &&
      event.key === "Tab" &&
      !event.shiftKey &&
      this.#managementButton !== undefined
    ) {
      this.#managementButton.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  #handleKey(key: string): boolean {
    if (key === "Tab") {
      this.#setOpen(false);
      return false;
    }
    if (key === "Escape") {
      if (!this.#open) return false;
      this.#setOpen(false);
      return true;
    }
    if (key === "Enter" || key === " ") {
      if (this.#open) this.#commit(this.#active);
      else this.#setOpen(true);
      return true;
    }
    return this.#navigate(key);
  }

  #navigate(key: string): boolean {
    if (/^(ArrowDown|ArrowUp|Home|End)$/.test(key)) {
      const wasOpen = this.#open;
      this.#setOpen(true);
      const last = this.#items.length - 1;
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? last
            : this.#active + (wasOpen ? (key === "ArrowDown" ? 1 : -1) : 0);
      this.#activate(Math.max(0, Math.min(last, next)));
      return true;
    }
    if (key.length !== 1) return false;
    this.#setOpen(true);
    for (let offset = 1; offset <= this.#items.length; offset += 1) {
      const index = (this.#active + offset) % this.#items.length;
      if (
        this.#control.options[index]?.label.toLocaleLowerCase().startsWith(key.toLocaleLowerCase())
      ) {
        this.#activate(index);
        break;
      }
    }
    return true;
  }

  #observePreviews(): void {
    const port = this.#options.fontPreviews;
    const intersectionObserverConstructor =
      this.#body.ownerDocument.defaultView?.IntersectionObserver;
    if (port === undefined || intersectionObserverConstructor === undefined) return;
    const observer: IntersectionObserver = new intersectionObserverConstructor(
      (entries) => {
        if (!this.#open || this.#disposed || this.#observer !== observer) return;
        for (const entry of entries) {
          const element = entry.target as HTMLElement;
          if (entry.isIntersecting && !this.#previews.has(element))
            this.#previews.set(element, port.acquire(element, element.dataset.value!));
          else if (!entry.isIntersecting) {
            this.#previews.get(element)?.();
            this.#previews.delete(element);
          }
        }
      },
      { root: this.#list },
    );
    this.#observer = observer;
    for (const item of this.#items) observer.observe(item);
  }
}
