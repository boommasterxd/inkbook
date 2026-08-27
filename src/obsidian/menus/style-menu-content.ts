import type { StyleChoiceOption, StyleControl } from "../../rendering/ui/index";
import {
  arrowShapeIconId,
  coordinateSystemIconId,
  OPACITY_ICON_ID,
  PRESSURE_SENSITIVITY_ICON_ID,
} from "../../rendering/ui/icon-ids";
import { menuDomWindow } from "./menu-dom";

export interface StyleMenuContentOptions {
  readonly controls: readonly StyleControl[];
  readonly ownerDocument: Document;
  readonly onChange: (controlId: string, value: boolean | number | string) => void;
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
  root.addEventListener("click", stopPropagation);
  // Obsidian's Menu cancels bubbling mouse downs, which suppresses native input interaction.
  root.addEventListener("mousedown", stopPropagation);
  root.addEventListener("pointerdown", stopPropagation);
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
    preview.style.setProperty("--inkbook-menu-line-style", value);
    return preview;
  }
  const iconId = choiceIconId(controlId, value);
  if (iconId === null) return null;
  preview.classList.add("inkbook-menu-option-icon");
  options.renderIcon(preview, iconId);
  return preview;
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
  const value = body.createEl("input");
  range.className = "inkbook-menu-slider";
  range.type = "range";
  range.min = String(control.min * scale);
  range.max = String(control.max * scale);
  range.step = String(control.step * scale);
  range.value = String((control.value ?? control.min) * scale);
  range.setAttribute("aria-label", control.label);
  if (control.mixed === true) range.setAttribute("aria-valuetext", "Mixed");
  value.className = "inkbook-menu-value";
  value.type = "number";
  value.min = range.min;
  value.max = range.max;
  value.step = range.step;
  value.value = control.value === null ? "" : formatNumber(control.value * scale);
  value.placeholder = control.mixed === true ? "Mixed" : "";
  value.setAttribute("aria-label", percent ? `${control.label} percent` : control.label);
  const suffix = body.createSpan({ cls: "inkbook-menu-value-suffix", text: percent ? "%" : "" });
  range.addEventListener("input", () => {
    value.value = formatNumber(range.valueAsNumber);
    range.removeAttribute("aria-valuetext");
  });
  range.addEventListener("change", () => {
    options.onChange(control.id, range.valueAsNumber / scale);
  });
  value.addEventListener("change", () => {
    const next = clamp(value.valueAsNumber, Number(range.min), Number(range.max));
    if (!Number.isFinite(next)) return;
    value.value = formatNumber(next);
    range.value = String(next);
    range.removeAttribute("aria-valuetext");
    options.onChange(control.id, next / scale);
  });
  body.append(range, value, suffix);
  return field;
}

function createStepper(
  options: StyleMenuContentOptions,
  control: Extract<StyleControl, { readonly kind: "number" }>,
): HTMLElement {
  const { field, body } = createField(options, control);
  body.classList.add("inkbook-menu-stepper");
  let current = control.value ?? control.min;
  const output = body.createEl("output");
  output.textContent = control.value === null ? "Mixed" : formatNumber(current);
  const decrement = createStepperButton(options, "minus", `Decrease ${control.label}`);
  const increment = createStepperButton(options, "plus", `Increase ${control.label}`);
  const commit = (delta: number) => {
    current = clamp(current + delta, control.min, control.max);
    output.textContent = formatNumber(current);
    options.onChange(control.id, current);
  };
  decrement.addEventListener("click", () => commit(-control.step));
  increment.addEventListener("click", () => commit(control.step));
  body.append(decrement, output, increment);
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
  const heading = label.createSpan({ cls: "inkbook-menu-toggle-heading" });
  const icon = heading.createSpan({ cls: "inkbook-menu-control-icon" });
  options.renderIcon(icon, CONTROL_ICONS[control.id] ?? "settings-2");
  heading.createSpan({ text: control.label });
  const switchControl = label.createSpan({ cls: "inkbook-menu-switch" });
  const input = switchControl.createEl("input");
  input.type = "checkbox";
  input.checked = control.checked;
  input.setAttribute("aria-label", control.label);
  input.addEventListener("change", () => options.onChange(control.id, input.checked));
  switchControl.createSpan({ cls: "inkbook-menu-switch-track" });
  return label;
}

function choiceIconId(controlId: string, value: string): string | null {
  if (controlId === "arrow-start-node")
    return arrowShapeIconId(value as Parameters<typeof arrowShapeIconId>[0], "none");
  if (controlId === "arrow-end-node")
    return arrowShapeIconId("none", value as Parameters<typeof arrowShapeIconId>[1]);
  if (controlId === "coordinate-dimension" && (value === "2d" || value === "3d"))
    return coordinateSystemIconId(value);
  return null;
}

function isVisualOnlyChoice(controlId: string): boolean {
  return (
    controlId.endsWith("color") ||
    controlId === "outline-style" ||
    controlId.startsWith("arrow-") ||
    controlId === "coordinate-dimension"
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

function stopPropagation(event: Event): void {
  event.stopPropagation();
}
