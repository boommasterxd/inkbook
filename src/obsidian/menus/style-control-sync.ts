import type { StyleControl } from "./editor-menu-types";
import { controlLabel, choiceLabel } from "./localized-style-labels";
import { menuTranslator, type MenuLocalizationOptions } from "./localized-menu-text";
import { formatStyleNumber, valueCharacterWidth } from "./style-number-format";

interface StyleControlSyncOptions extends MenuLocalizationOptions {
  readonly controls: readonly StyleControl[];
  readonly choices: ReadonlyMap<string, (value: string | null) => void>;
  readonly toggles: ReadonlyMap<string, (checked: boolean, mixed: boolean) => void>;
  readonly registerCleanup?: ((cleanup: () => void) => void) | undefined;
}

interface ControlSlot {
  current: StyleControl;
  applied: StyleControl;
  pending: boolean;
  readonly project: (control: StyleControl, force?: boolean) => boolean;
}

/** Bounded chrome projection; source parsing and document mutation stay outside this layer. */
export function createStyleControlSync(root: HTMLElement, options: StyleControlSyncOptions) {
  const slots = new Map<string, ControlSlot>();
  let disposed = false;
  for (const control of options.controls) {
    const field = root.querySelector<HTMLElement>(`[data-control="${control.id}"]`);
    if (field === null) continue;
    const slot: ControlSlot = {
      current: control,
      applied: control,
      pending: false,
      project: controlProjection(field, control, options),
    };
    slots.set(control.id, slot);
    if (control.kind === "number") {
      const blur = (event: FocusEvent): void => {
        if (!slot.pending || field.contains(event.relatedTarget as Node | null)) return;
        if (slot.project(slot.current, true)) {
          slot.applied = slot.current;
          slot.pending = false;
        }
      };
      field.addEventListener("focusout", blur);
      options.registerCleanup?.(() => field.removeEventListener("focusout", blur));
    }
  }
  options.registerCleanup?.(() => {
    disposed = true;
    slots.clear();
  });
  options.registerLocaleUpdate?.(() => {
    if (!disposed) for (const slot of slots.values()) slot.project(slot.current);
  });
  return (controls: readonly StyleControl[]): void => {
    if (disposed) return;
    for (const control of controls) {
      const slot = slots.get(control.id);
      if (slot === undefined || slot.current.kind !== control.kind) continue;
      slot.current = control;
      if (!slot.pending && sameControlValue(slot.applied, control)) continue;
      slot.pending = !slot.project(control);
      if (!slot.pending) slot.applied = control;
    }
  };
}

function sameControlValue(a: StyleControl, b: StyleControl): boolean {
  if (a.kind !== b.kind || (a.mixed === true) !== (b.mixed === true)) return false;
  return a.kind === "toggle" && b.kind === "toggle"
    ? a.checked === b.checked
    : a.kind !== "toggle" && b.kind !== "toggle" && a.value === b.value;
}

function controlProjection(
  field: HTMLElement,
  initial: StyleControl,
  options: StyleControlSyncOptions,
) {
  const heading = field.querySelector<HTMLElement>(".inkbook-menu-control-label");
  const valueHeading = field.querySelector<HTMLElement>(".inkbook-menu-control-value-label");
  const project = valueProjection(field, initial, options);
  return (control: StyleControl, force = false): boolean => {
    const label = controlLabel(options, control);
    if (heading !== null)
      setText(
        heading,
        control.mixed === true && valueHeading === null
          ? menuTranslator(options)("editor.style.mixed-label", { label })
          : label,
      );
    if (valueHeading !== null && control.kind === "choice") {
      const option = control.options.find(({ value }) => value === control.value);
      setText(
        valueHeading,
        control.mixed === true || option === undefined
          ? menuTranslator(options)("editor.style.mixed")
          : choiceLabel(options, control.id, option),
      );
    }
    return project(control, force);
  };
}

function valueProjection(
  field: HTMLElement,
  initial: StyleControl,
  options: StyleControlSyncOptions,
) {
  if (initial.kind === "number") return numberProjection(field, options);
  if (initial.kind === "toggle") {
    const restore = options.toggles.get(initial.id);
    const input = field.querySelector<HTMLInputElement>('input[type="checkbox"]');
    return (control: StyleControl): boolean => {
      if (control.kind !== "toggle") return true;
      if (restore !== undefined) restore(control.checked, control.mixed === true);
      if (input !== null) {
        input.checked = control.checked;
        input.indeterminate = control.mixed === true;
        setAttribute(
          input,
          "aria-checked",
          control.mixed === true ? "mixed" : String(control.checked),
        );
      }
      return true;
    };
  }
  const restore = options.choices.get(initial.id);
  const buttons = [...field.querySelectorAll<HTMLButtonElement>("button[data-value]")];
  return (control: StyleControl): boolean => {
    if (control.kind !== "choice") return true;
    if (restore !== undefined) restore(control.value);
    else
      for (const button of buttons)
        setAttribute(button, "aria-pressed", String(button.dataset.value === control.value));
    return true;
  };
}

function numberProjection(field: HTMLElement, options: StyleControlSyncOptions) {
  const range = field.querySelector<HTMLInputElement>('input[type="range"]');
  const value = field.querySelector<HTMLInputElement>('input[type="number"]');
  return (control: StyleControl, force = false): boolean => {
    if (control.kind !== "number" || value === null) return true;
    if (!force && field.contains(field.ownerDocument.activeElement)) return false;
    const scale = control.id.includes("opacity") ? 100 : 1;
    const numeric =
      control.value === null ? "" : formatStyleNumber(control.value * scale, control.id);
    if (value.value !== numeric) value.value = numeric;
    if (value.defaultValue !== numeric) value.defaultValue = numeric;
    value.placeholder = control.mixed === true ? "—" : "";
    value.style.setProperty(
      "--inkbook-menu-value-width",
      `${valueCharacterWidth(control, scale, value.placeholder)}ch`,
    );
    if (range !== null) {
      const next = String((control.value ?? control.min) * scale);
      if (range.value !== next) range.value = next;
      if (control.mixed === true)
        setAttribute(range, "aria-valuetext", menuTranslator(options)("editor.style.mixed"));
      else range.removeAttribute("aria-valuetext");
    }
    return true;
  };
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
