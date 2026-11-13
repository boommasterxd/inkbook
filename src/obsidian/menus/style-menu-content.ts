import { controlLabel, choiceLabel } from "./localized-style-labels";
import {
  menuTranslator,
  updateMenuText,
  type MenuLocalizationOptions,
} from "./localized-menu-text";
import { createChoicePreview } from "./style-choice-preview";
import { createFontChoiceDropdown, type FontChoiceDropdownOptions } from "./font-choice-dropdown";

import type { StyleChoiceOption, StyleControl } from "./editor-menu-types";
import { OPACITY_ICON_ID, PRESSURE_SENSITIVITY_ICON_ID } from "../../rendering/ui/icon-ids";
import { configureMenuTooltips, menuDomWindow } from "./menu-dom";
import { createStyleControlSync } from "./style-control-sync";
import { formatStyleNumber, valueCharacterWidth } from "./style-number-format";
import {
  createStyleToggleButtons,
  isIconToggle,
  type StyleToggleButtonsOptions,
} from "./style-toggle-buttons";

export interface StyleMenuContentOptions
  extends
    MenuLocalizationOptions,
    Omit<FontChoiceDropdownOptions, "workScheduler">,
    StyleToggleButtonsOptions {
  readonly workScheduler?: FontChoiceDropdownOptions["workScheduler"] | undefined;
  readonly controlDescriptions?: Readonly<Record<string, string>>;
  readonly controls: readonly StyleControl[];
  readonly numberInputMode?: "clamp" | "reject";
  readonly ownerDocument: Document;
  readonly onChange: (controlId: string, value: boolean | number | string) => void;
  readonly onPreview?: ((controlId: string, value: boolean | number | string) => void) | undefined;
  readonly onInvalidValue?: (controlId: string) => void;
  readonly registerStyleSync?: (sync: (controls: readonly StyleControl[]) => void) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

let nextControlLabel = 0;

const CONTROL_ICONS: Readonly<Record<string, string>> = {
  "text-font-family": "type",
  "text-font-size": "a-large-small",
  "text-bold": "bold",
  "text-italic": "italic",
  "text-underline": "underline",
  "text-strikethrough": "strikethrough",
  "text-alignment": "align-left",
  "text-background-color": "paint-bucket",
  "text-background-opacity": OPACITY_ICON_ID,
  color: "palette",
  "stroke-width": "minus",
  opacity: OPACITY_ICON_ID,
  "pressure-enabled": PRESSURE_SENSITIVITY_ICON_ID,
  "hold-to-shape-enabled": "shapes",
  "snapping-enabled": "magnet",
  "eraser-radius": "eraser",
  "outline-color": "palette",
  "outline-width": "minus",
  "outline-style": "ellipsis",
  "outline-opacity": OPACITY_ICON_ID,
  "fill-color": "paint-bucket",
  "fill-opacity": OPACITY_ICON_ID,
  "arrow-start-node": "move-left",
  "arrow-end-node": "move-right",
  "coordinate-dimension": "box",
  "table-columns": "columns-3",
  "active-buffer-lines": "rows-3",
};

export function createStyleMenuContent(options: StyleMenuContentOptions): DocumentFragment {
  const original = options;
  const choices = new Map<string, (value: string | null) => void>();
  const toggles = new Map<string, (checked: boolean, mixed: boolean) => void>();
  options = {
    ...options,
    registerChoiceRestore: (id, restore) => {
      choices.set(id, restore);
      original.registerChoiceRestore?.(id, restore);
    },
    registerToggleRestore: (id, restore) => {
      toggles.set(id, restore);
      original.registerToggleRestore?.(id, restore);
    },
  };
  const fragment = menuDomWindow(options.ownerDocument, "style menu").createFragment();
  const root = fragment.createDiv({ cls: "inkbook-menu-controls" });
  if (options.controls.length === 0) {
    const empty = root.createEl("p", {
      cls: "inkbook-menu-empty",
      text: menuTranslator(options)("editor.style.empty"),
    });
    updateMenuText(options, () => {
      empty.textContent = menuTranslator(options)("editor.style.empty");
    });
    root.append(empty);
  } else {
    let toggles: Extract<StyleControl, { kind: "toggle" }>[] = [];
    const flushToggles = (): void => {
      if (toggles.length > 0) root.append(createStyleToggleButtons(options, toggles));
      toggles = [];
    };
    for (const control of options.controls) {
      if (isIconToggle(control)) toggles.push(control);
      else {
        flushToggles();
        root.append(createControl(options, control));
      }
    }
    flushToggles();
  }
  fragment.append(root);
  configureMenuTooltips(fragment);
  options.registerStyleSync?.(createStyleControlSync(root, { ...options, choices, toggles }));
  return fragment;
}

function createControl(options: StyleMenuContentOptions, control: StyleControl): HTMLElement {
  if (control.kind === "toggle") return createToggle(options, control);
  if (control.kind === "number") {
    return control.id === "table-columns"
      ? createStepper(options, control)
      : createSlider(options, control);
  }
  return createChoices(options, control);
}

function createField(
  options: StyleMenuContentOptions,
  control: StyleControl,
): { readonly field: HTMLElement; readonly body: HTMLElement } {
  const field = menuDomWindow(options.ownerDocument, "style menu").createEl("section", {
    cls: "inkbook-menu-control",
  });
  field.dataset.control = control.id;
  const header = field.createDiv({ cls: "inkbook-menu-control-header" });
  const icon = header.createSpan({ cls: "inkbook-menu-control-icon" });
  options.renderIcon(icon, CONTROL_ICONS[control.id] ?? "settings-2");
  const label = header.createSpan({ cls: "inkbook-menu-control-label" });
  label.id = `inkbook-style-label-${++nextControlLabel}`;
  field.setAttribute("role", "group");
  field.setAttribute("aria-labelledby", label.id);
  updateMenuText(options, () => {
    label.textContent =
      "mixed" in control && control.mixed === true
        ? menuTranslator(options)("editor.style.mixed-label", {
            label: controlLabel(options, control),
          })
        : controlLabel(options, control);
    if (
      control.kind === "choice" &&
      (control.id === "arrow-start-node" || control.id === "arrow-end-node")
    ) {
      label.textContent = controlLabel(options, control);
      const valueLabel =
        header.querySelector<HTMLElement>(".inkbook-menu-control-value-label") ??
        header.createSpan({ cls: "inkbook-menu-control-value-label" });
      valueLabel.id = `${label.id}-value`;
      valueLabel.textContent =
        control.mixed === true
          ? menuTranslator(options)("editor.style.mixed")
          : (control.options.find((option) => option.value === control.value)?.label ??
            menuTranslator(options)("editor.style.mixed"));
      field.setAttribute("aria-labelledby", `${label.id} ${valueLabel.id}`);
    }
  });
  const description = options.controlDescriptions?.[control.id];
  if (description !== undefined) {
    field.createEl("p", { cls: "inkbook-menu-control-description", text: description });
  }
  const body = field.createDiv({ cls: "inkbook-menu-control-body" });
  return { field, body };
}

function createChoices(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "choice" }>,
): HTMLElement {
  const { field, body } = createField(options, control);
  if (control.id === "text-font-family") {
    const workScheduler = options.workScheduler;
    if (workScheduler === undefined) throw new Error("Font choices require a work scheduler.");
    createFontChoiceDropdown(body, control, { ...options, workScheduler });
    return field;
  }
  body.classList.add("inkbook-menu-choice-grid");
  if (control.id.endsWith("color")) body.classList.add("inkbook-menu-color-grid");
  if (control.id.endsWith("width")) body.classList.add("inkbook-menu-width-grid");
  if (control.id === "selection-area") body.classList.add("inkbook-menu-selection-area-grid");
  if (control.id === "selection-inclusion") {
    body.classList.add("inkbook-menu-selection-inclusion-grid");
  }
  const valueLabel = field.querySelector<HTMLElement>(".inkbook-menu-control-value-label");
  for (const option of control.options) {
    body.append(createChoiceButton(options, control, option, valueLabel));
  }
  return field;
}

function createChoiceButton(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "choice" }>,
  option: StyleChoiceOption,
  valueLabel: HTMLElement | null,
): HTMLButtonElement {
  const button = menuDomWindow(options.ownerDocument, "style menu").createEl("button", {
    cls: "inkbook-menu-choice",
  });
  button.type = "button";

  button.setAttribute("aria-pressed", String(control.value === option.value));
  button.dataset.value = option.value;
  if (control.id.endsWith("width")) button.classList.add("inkbook-menu-width-choice");
  const preview = createChoicePreview(options, control.id, option.value);
  const label = button.createSpan({ cls: "inkbook-menu-choice-label" });
  updateMenuText(options, () => {
    const text = choiceLabel(options, control.id, option);
    button.setAttribute("aria-label", text);
    label.textContent = text;
    if (valueLabel !== null && button.getAttribute("aria-pressed") === "true")
      valueLabel.textContent = text;
  });
  if (isVisualOnlyChoice(control.id)) label.classList.add("inkbook-menu-visually-hidden");
  if (preview !== null) button.append(preview);
  button.append(label);
  button.addEventListener("click", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    for (const sibling of button.parentElement?.querySelectorAll("button") ?? []) {
      sibling.setAttribute("aria-pressed", String(sibling === button));
    }
    if (valueLabel !== null) valueLabel.textContent = choiceLabel(options, control.id, option);
    options.onChange(control.id, option.value);
  });
  return button;
}

function createSlider(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "number" }>,
): HTMLElement {
  const { field, body } = createField(options, control);
  body.classList.add("inkbook-menu-slider-row");
  const percent = control.id.includes("opacity");
  const scale = percent ? 100 : 1;
  const range = body.createEl("input");
  const { valueField, value } = createNumberValueField(body, control, options, scale);
  value.defaultValue = value.value;
  range.className = "inkbook-menu-slider";
  range.type = "range";
  range.min = String(control.min * scale);
  range.max = String(control.max * scale);
  range.step = control.step === "any" ? "any" : percent ? "1" : String(control.step * scale);
  range.value = String((control.value ?? control.min) * scale);
  updateMenuText(options, () => range.setAttribute("aria-label", controlLabel(options, control)));
  if (control.mixed === true) {
    range.setAttribute("aria-valuetext", menuTranslator(options)("editor.style.mixed"));
    updateMenuText(options, () => {
      if (range.hasAttribute("aria-valuetext"))
        range.setAttribute("aria-valuetext", menuTranslator(options)("editor.style.mixed"));
    });
  }
  range.addEventListener("input", () => {
    value.value = formatStyleNumber(range.valueAsNumber, control.id);
    value.defaultValue = value.value;
    range.removeAttribute("aria-valuetext");
    if (control.id === "text-font-size") options.onPreview?.(control.id, range.valueAsNumber);
  });
  range.addEventListener("change", () => {
    options.onChange(control.id, range.valueAsNumber / scale);
  });
  value.addEventListener("input", () => {
    const next = valueInRange(value, range, options.numberInputMode);
    if (next === undefined) return;
    range.value = String(next);
    value.defaultValue = formatStyleNumber(next, control.id);
    range.removeAttribute("aria-valuetext");
    if (control.id === "text-font-size") options.onPreview?.(control.id, next);
  });
  value.addEventListener("change", () => {
    if (
      control.id === "text-font-size" &&
      value.value === value.defaultValue &&
      (value.valueAsNumber < control.min || value.valueAsNumber > control.max)
    )
      return;
    const next = valueInRange(value, range, options.numberInputMode);
    if (next === undefined) {
      value.value = value.defaultValue;
      options.onInvalidValue?.(control.id);
      return;
    }
    value.value = formatStyleNumber(next, control.id);
    value.defaultValue = value.value;
    range.value = String(next);
    range.removeAttribute("aria-valuetext");
    options.onChange(control.id, next / scale);
  });
  body.append(range, valueField);
  return field;
}

function createNumberValueField(
  body: HTMLElement,
  control: Extract<StyleControl, { readonly kind: "number" }>,
  options: StyleMenuContentOptions,
  scale = 1,
): { readonly valueField: HTMLElement; readonly value: HTMLInputElement } {
  const valueField = body.createEl("label", { cls: "inkbook-menu-value-field" });
  const valueContent = valueField.createSpan({ cls: "inkbook-menu-value-content" });
  const value = valueContent.createEl("input");
  value.className = "inkbook-menu-value";
  value.type = "number";
  value.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    value.blur();
  });
  value.min = String(control.min * scale);
  value.max = String(control.max * scale);
  value.step = scale === 100 ? "1" : String(control.step);
  value.value = control.value === null ? "" : formatStyleNumber(control.value * scale, control.id);
  value.placeholder = control.mixed === true ? "—" : "";
  updateMenuText(options, () =>
    value.setAttribute(
      "aria-label",
      scale === 100
        ? menuTranslator(options)("editor.style.percent", { label: controlLabel(options, control) })
        : controlLabel(options, control),
    ),
  );
  value.style.setProperty(
    "--inkbook-menu-value-width",
    `${String(valueCharacterWidth(control, scale, value.placeholder))}ch`,
  );
  valueContent.createSpan({ cls: "inkbook-menu-value-suffix", text: scale === 100 ? "%" : "" });
  return { valueField, value };
}

function valueInRange(
  value: HTMLInputElement,
  range: HTMLInputElement,
  mode: StyleMenuContentOptions["numberInputMode"],
): number | undefined {
  if (!Number.isFinite(value.valueAsNumber)) return undefined;
  if (
    mode === "reject" &&
    (value.valueAsNumber < Number(range.min) || value.valueAsNumber > Number(range.max))
  ) {
    return undefined;
  }
  return clamp(value.valueAsNumber, Number(range.min), Number(range.max));
}

function createStepper(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "number" }>,
): HTMLElement {
  const { field, body } = createField(options, control);
  body.classList.add("inkbook-menu-stepper");
  const { valueField, value } = createNumberValueField(body, control, options);
  value.defaultValue = value.value;
  value.inputMode = "numeric";
  const decrement = createStepperButton(
    options,
    "minus",
    menuTranslator(options)("editor.style.decrease", { label: controlLabel(options, control) }),
  );
  const increment = createStepperButton(
    options,
    "plus",
    menuTranslator(options)("editor.style.increase", { label: controlLabel(options, control) }),
  );
  updateMenuText(options, () => {
    decrement.setAttribute(
      "aria-label",
      menuTranslator(options)("editor.style.decrease", { label: controlLabel(options, control) }),
    );
    increment.setAttribute(
      "aria-label",
      menuTranslator(options)("editor.style.increase", { label: controlLabel(options, control) }),
    );
  });
  const commit = (next: number) => {
    const current = clamp(Math.round(next), control.min, control.max);
    value.value = formatStyleNumber(current, control.id);
    value.defaultValue = value.value;
    options.onChange(control.id, current);
  };
  value.addEventListener("change", () => {
    const next = valueInRange(value, value, options.numberInputMode);
    if (next === undefined) {
      value.value = value.defaultValue;
      options.onInvalidValue?.(control.id);
      return;
    }
    commit(next);
  });
  const currentValue = (): number =>
    Number.isFinite(value.valueAsNumber)
      ? value.valueAsNumber
      : Number(value.defaultValue || control.min);
  decrement.addEventListener("click", () => commit(currentValue() - Number(control.step)));
  increment.addEventListener("click", () => commit(currentValue() + Number(control.step)));
  body.append(decrement, valueField, increment);
  return field;
}

function createStepperButton(
  options: StyleMenuContentOptions,
  iconId: string,
  label: string,
): HTMLButtonElement {
  const button = menuDomWindow(options.ownerDocument, "style menu").createEl("button");
  button.type = "button";
  button.className = "inkbook-menu-stepper-button";
  button.setAttribute("aria-label", label);
  options.renderIcon(button, iconId);
  return button;
}

function createToggle(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "toggle" }>,
): HTMLElement {
  const label = menuDomWindow(options.ownerDocument, "style menu").createEl("label", {
    cls: "inkbook-menu-control inkbook-menu-toggle-row",
  });
  label.dataset.control = control.id;
  const copy = label.createSpan({ cls: "inkbook-menu-toggle-copy" });
  const heading = copy.createSpan({ cls: "inkbook-menu-toggle-heading" });
  const icon = heading.createSpan({ cls: "inkbook-menu-control-icon" });
  options.renderIcon(icon, CONTROL_ICONS[control.id] ?? "settings-2");
  const title = heading.createSpan({ cls: "inkbook-menu-toggle-label" });
  updateMenuText(options, () => {
    title.textContent = controlLabel(options, control);
  });
  const description = options.controlDescriptions?.[control.id];
  const descriptionElement =
    description === undefined
      ? undefined
      : copy.createSpan({ cls: "inkbook-menu-control-description", text: description });
  const switchControl = label.createSpan({ cls: "inkbook-menu-switch" });
  const input = switchControl.createEl("input");
  input.type = "checkbox";
  input.checked = control.checked;
  input.indeterminate = control.mixed === true;
  input.setAttribute("aria-checked", control.mixed === true ? "mixed" : String(control.checked));
  updateMenuText(options, () => input.setAttribute("aria-label", controlLabel(options, control)));
  if (descriptionElement !== undefined) {
    descriptionElement.id = `inkbook-style-description-${++nextControlLabel}`;
    input.setAttribute("aria-describedby", descriptionElement.id);
  }
  input.addEventListener("change", () => {
    input.indeterminate = false;
    input.setAttribute("aria-checked", String(input.checked));
    options.onChange(control.id, input.checked);
  });
  switchControl.createSpan({ cls: "inkbook-menu-switch-track" }).createSpan({
    cls: "inkbook-menu-switch-thumb",
  });
  return label;
}

function isVisualOnlyChoice(controlId: string): boolean {
  return (
    controlId.endsWith("color") ||
    controlId === "text-alignment" ||
    controlId === "outline-style" ||
    controlId.startsWith("arrow-") ||
    controlId === "coordinate-dimension" ||
    controlId === "selection-area"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
