import { outlineDashPattern } from "../../domain/geometry/element-path";

import type { StyleChoiceOption, StyleControl } from "./editor-menu-types";
import {
  arrowShapeIconId,
  coordinateSystemIconId,
  OPACITY_ICON_ID,
  PRESSURE_SENSITIVITY_ICON_ID,
  selectionAreaIconId,
} from "../../rendering/ui/icon-ids";
import { menuDomWindow } from "./menu-dom";

export interface StyleMenuContentOptions {
  readonly controlDescriptions?: Readonly<Record<string, string>>;
  readonly controls: readonly StyleControl[];
  readonly numberInputMode?: "clamp" | "reject";
  readonly ownerDocument: Document;
  readonly onChange: (controlId: string, value: boolean | number | string) => void;
  readonly onInvalidValue?: (controlId: string) => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
}

const CONTROL_ICONS: Readonly<Record<string, string>> = {
  color: "palette",
  "stroke-width": "minus",
  opacity: OPACITY_ICON_ID,
  "pressure-enabled": PRESSURE_SENSITIVITY_ICON_ID,
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

const WIDTH_PREVIEW_PIXELS: Readonly<Record<string, number>> = {
  "1": 0.5,
  "2": 1,
  "4": 2.5,
  "8": 4,
  "12": 5.5,
  "14": 6,
  "22": 8,
};

export function createStyleMenuContent(options: StyleMenuContentOptions): DocumentFragment {
  const fragment = menuDomWindow(options.ownerDocument, "style menu").createFragment();
  const root = fragment.createDiv({ cls: "inkbook-menu-controls" });
  if (options.controls.length === 0) {
    const empty = root.createEl("p", {
      cls: "inkbook-menu-empty",
      text: "No shared style options",
    });
    root.append(empty);
  } else {
    for (const control of options.controls) root.append(createControl(options, control));
  }
  fragment.append(root);
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
  const label = header.createSpan();
  label.textContent =
    "mixed" in control && control.mixed === true ? `${control.label} · Mixed` : control.label;
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
  body.classList.add("inkbook-menu-choice-grid");
  if (control.id.endsWith("color")) body.classList.add("inkbook-menu-color-grid");
  if (control.id.endsWith("width")) body.classList.add("inkbook-menu-width-grid");
  if (control.id === "selection-area") body.classList.add("inkbook-menu-selection-area-grid");
  if (control.id === "selection-inclusion") {
    body.classList.add("inkbook-menu-selection-inclusion-grid");
  }
  for (const option of control.options) {
    body.append(createChoiceButton(options, control, option));
  }
  return field;
}

function createChoiceButton(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "choice" }>,
  option: StyleChoiceOption,
): HTMLButtonElement {
  const button = menuDomWindow(options.ownerDocument, "style menu").createEl("button", {
    cls: "inkbook-menu-choice",
  });
  button.type = "button";
  button.setAttribute("aria-label", option.label);
  button.setAttribute("aria-pressed", String(control.value === option.value));
  button.dataset.value = option.value;
  if (control.id.endsWith("width")) button.classList.add("inkbook-menu-width-choice");
  const preview = createChoicePreview(options, control.id, option.value);
  const label = button.createSpan({ cls: "inkbook-menu-choice-label" });
  label.textContent = option.label;
  if (isVisualOnlyChoice(control.id)) label.classList.add("inkbook-menu-visually-hidden");
  if (preview !== null) button.append(preview);
  button.append(label);
  button.addEventListener("click", (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    for (const sibling of button.parentElement?.querySelectorAll("button") ?? []) {
      sibling.setAttribute("aria-pressed", String(sibling === button));
    }
    options.onChange(control.id, option.value);
  });
  return button;
}

function createChoicePreview(
  options: StyleMenuContentOptions,
  controlId: string,
  value: string,
): HTMLElement | null {
  const preview = menuDomWindow(options.ownerDocument, "style menu").createSpan({
    cls: "inkbook-menu-choice-preview",
  });
  if (controlId.endsWith("color")) {
    preview.classList.add("inkbook-menu-color-swatch");
    preview.dataset.empty = value === "none" ? "true" : undefined;
    preview.style.setProperty(
      "--inkbook-menu-color",
      value === "theme-text" ? "var(--text-normal)" : value,
    );
    return preview;
  }
  if (controlId.endsWith("width")) {
    preview.classList.add("inkbook-menu-line-preview");
    preview.style.setProperty("--inkbook-menu-line-width", `${String(widthPreview(value))}px`);
    return preview;
  }
  if (controlId === "outline-style") {
    preview.classList.add("inkbook-menu-line-preview");
    preview.append(createOutlineStylePreview(options.ownerDocument, value));
    return preview;
  }
  const iconId = choiceIconId(controlId, value);
  if (iconId === null) return null;
  preview.classList.add("inkbook-menu-option-icon");
  options.renderIcon(preview, iconId);
  return preview;
}

function createOutlineStylePreview(ownerDocument: Document, value: string): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const width = 2;
  const dash = outlineDashPattern(
    value === "dashed" || value === "dotted" ? value : "solid",
    width,
  );
  const svg = ownerDocument.createElementNS(namespace, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("viewBox", "0 0 28 8");
  const path = ownerDocument.createElementNS(namespace, "path");
  path.setAttribute("d", "M 2 4 H 26");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", String(width));
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  if (dash !== null) path.setAttribute("stroke-dasharray", dash.join(" "));
  svg.append(path);
  return svg;
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
  const { valueField, value } = createNumberValueField(body, control, scale);
  range.className = "inkbook-menu-slider";
  range.type = "range";
  range.min = String(control.min * scale);
  range.max = String(control.max * scale);
  range.step = percent ? "1" : String(control.step * scale);
  range.value = String((control.value ?? control.min) * scale);
  range.setAttribute("aria-label", control.label);
  if (control.mixed === true) range.setAttribute("aria-valuetext", "Mixed");
  range.addEventListener("input", () => {
    value.value = formatNumber(range.valueAsNumber);
    range.removeAttribute("aria-valuetext");
  });
  range.addEventListener("change", () => {
    options.onChange(control.id, range.valueAsNumber / scale);
  });
  value.addEventListener("input", () => {
    const next = valueInRange(value, range, options.numberInputMode);
    if (next === undefined) return;
    range.value = String(next);
    range.removeAttribute("aria-valuetext");
  });
  value.addEventListener("change", () => {
    const next = valueInRange(value, range, options.numberInputMode);
    if (next === undefined) {
      value.value = formatNumber(range.valueAsNumber);
      options.onInvalidValue?.(control.id);
      return;
    }
    value.value = formatNumber(next);
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
  scale = 1,
): { readonly valueField: HTMLElement; readonly value: HTMLInputElement } {
  const valueField = body.createEl("label", { cls: "inkbook-menu-value-field" });
  const valueContent = valueField.createSpan({ cls: "inkbook-menu-value-content" });
  const value = valueContent.createEl("input");
  value.className = "inkbook-menu-value";
  value.type = "number";
  value.min = String(control.min * scale);
  value.max = String(control.max * scale);
  value.step = scale === 100 ? "1" : String(control.step);
  value.value = control.value === null ? "" : formatNumber(control.value * scale);
  value.placeholder = control.mixed === true ? "—" : "";
  value.setAttribute("aria-label", scale === 100 ? `${control.label} percent` : control.label);
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

function valueCharacterWidth(
  control: Extract<StyleControl, { readonly kind: "number" }>,
  scale: number,
  placeholder: string,
): number {
  return Math.max(
    formatNumber(control.min * scale).length,
    formatNumber(control.max * scale).length,
    placeholder.length,
  );
}

function createStepper(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "number" }>,
): HTMLElement {
  const { field, body } = createField(options, control);
  body.classList.add("inkbook-menu-stepper");
  const { valueField, value } = createNumberValueField(body, control);
  value.defaultValue = value.value;
  value.inputMode = "numeric";
  const decrement = createStepperButton(options, "minus", `Decrease ${control.label}`);
  const increment = createStepperButton(options, "plus", `Increase ${control.label}`);
  const commit = (next: number) => {
    const current = clamp(Math.round(next), control.min, control.max);
    value.value = formatNumber(current);
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
  value.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    value.blur();
  });
  const currentValue = (): number =>
    Number.isFinite(value.valueAsNumber)
      ? value.valueAsNumber
      : Number(value.defaultValue || control.min);
  decrement.addEventListener("click", () => commit(currentValue() - control.step));
  increment.addEventListener("click", () => commit(currentValue() + control.step));
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
  heading.createSpan({ text: control.label });
  const description = options.controlDescriptions?.[control.id];
  if (description !== undefined) {
    copy.createSpan({ cls: "inkbook-menu-control-description", text: description });
  }
  const switchControl = label.createSpan({ cls: "inkbook-menu-switch" });
  const input = switchControl.createEl("input");
  input.type = "checkbox";
  input.checked = control.checked;
  input.setAttribute("aria-label", control.label);
  input.addEventListener("change", () => options.onChange(control.id, input.checked));
  switchControl.createSpan({ cls: "inkbook-menu-switch-track" }).createSpan({
    cls: "inkbook-menu-switch-thumb",
  });
  return label;
}

function choiceIconId(controlId: string, value: string): string | null {
  if (controlId === "arrow-start-node")
    return arrowShapeIconId(value as Parameters<typeof arrowShapeIconId>[0], "none");
  if (controlId === "arrow-end-node")
    return arrowShapeIconId("none", value as Parameters<typeof arrowShapeIconId>[1]);
  if (controlId === "coordinate-dimension" && (value === "2d" || value === "3d"))
    return coordinateSystemIconId(value);
  if (controlId === "selection-area" && (value === "rectangle" || value === "lasso"))
    return selectionAreaIconId(value);
  return null;
}

function isVisualOnlyChoice(controlId: string): boolean {
  return (
    controlId.endsWith("color") ||
    controlId === "outline-style" ||
    controlId.startsWith("arrow-") ||
    controlId === "coordinate-dimension" ||
    controlId === "selection-area"
  );
}

function widthPreview(value: string): number {
  return WIDTH_PREVIEW_PIXELS[value] ?? Math.min(8, Math.max(1, Math.log2(Number(value))));
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
