import type { StyleControl } from "./editor-menu-types";
import { controlLabel } from "./localized-style-labels";
import {
  menuTranslator,
  updateMenuText,
  type MenuLocalizationOptions,
} from "./localized-menu-text";
import { menuDomWindow } from "./menu-dom";

type ToggleControl = Extract<StyleControl, { kind: "toggle" }>;
export interface StyleToggleButtonsOptions extends MenuLocalizationOptions {
  readonly ownerDocument: Document;
  readonly controlDescriptions?: Readonly<Record<string, string>>;
  readonly onChange: (controlId: string, value: boolean | number | string) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly registerToggleRestore?: (
    id: string,
    restore: (checked: boolean, mixed: boolean) => void,
  ) => void;
}

let nextGroup = 0;

export function isIconToggle(control: StyleControl): control is ToggleControl {
  return control.kind === "toggle" && control.presentation === "icon";
}

/** Independent toggle semantics share the existing choice paint and gesture owner. */
export function createStyleToggleButtons(
  options: StyleToggleButtonsOptions,
  controls: readonly ToggleControl[],
): HTMLElement {
  const field = menuDomWindow(options.ownerDocument, "style toggle buttons").createEl("section", {
    cls: "inkbook-menu-control",
  });
  field.setAttribute("role", "group");
  const label = field.createSpan({ cls: "inkbook-menu-visually-hidden" });
  label.id = `inkbook-style-toggle-group-${++nextGroup}`;
  field.setAttribute("aria-labelledby", label.id);
  updateMenuText(options, () => {
    label.textContent = menuTranslator(options)("editor.action.style");
  });
  const row = field.createDiv({ cls: "inkbook-menu-choice-grid inkbook-menu-toggle-button-grid" });
  for (const control of controls) {
    const cell = row.createDiv({ cls: "inkbook-menu-toggle-button-cell" });
    cell.dataset.control = control.id;
    const button = cell.createEl("button", { cls: "inkbook-menu-choice" });
    button.type = "button";
    const setState = (checked: boolean, mixed: boolean): void => {
      button.setAttribute("aria-pressed", mixed ? "mixed" : String(checked));
    };
    setState(control.checked, control.mixed === true);
    options.registerToggleRestore?.(control.id, setState);
    updateMenuText(options, () =>
      button.setAttribute("aria-label", controlLabel(options, control)),
    );
    const icon = button.createSpan({ cls: "inkbook-menu-control-icon" });
    icon.setAttribute("aria-hidden", "true");
    options.renderIcon(icon, control.id.slice("text-".length));
    const description = options.controlDescriptions?.[control.id];
    if (description !== undefined)
      cell.createSpan({
        cls: "inkbook-menu-control-description inkbook-menu-visually-hidden",
        text: description,
      });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const checked = button.getAttribute("aria-pressed") !== "true";
      setState(checked, false);
      options.onChange(control.id, checked);
    });
  }
  return field;
}
