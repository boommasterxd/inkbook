import { createEnglishLocalization } from "../../domain/localization";
import { setIcon, type Keymap } from "obsidian";

import type { StyleControl } from "../menus/editor-menu-types";
import type {
  FontOptionPreviewPort,
  FontChoiceDropdownOptions,
} from "../menus/font-choice-dropdown";
import { createStyleMenuContent } from "../menus/style-menu-content";
import { formatStyleNumber } from "../menus/style-number-format";
import {
  registerNativeControlFeedback,
  type NativeControlFeedbackOptions,
} from "../menus/feedback/native-control-feedback";
import { createSettingsValidationMotion } from "./settings-validation-motion";
import { SettingsWriteFeedback } from "./settings-write-feedback";

export interface SettingsControlContentOptions extends NativeControlFeedbackOptions {
  readonly workScheduler?: FontChoiceDropdownOptions["workScheduler"] | undefined;
  readonly keymap?: Pick<Keymap, "pushScope" | "popScope"> | undefined;
  readonly fontPreviews?: FontOptionPreviewPort | undefined;
  readonly fontManagementAction?: FontChoiceDropdownOptions["fontManagementAction"];
  readonly controls: () => readonly StyleControl[];
  readonly descriptions: Readonly<Record<string, string>>;
  readonly idPrefix: string;
  readonly onChange: (controlId: string, value: boolean | number | string) => Promise<void>;
  readonly ownerDocument: Document;
}

export function renderSettingsControlContent(
  container: HTMLElement,
  options: SettingsControlContentOptions,
): () => void {
  const writes = new SettingsWriteFeedback(options.t);
  const validation = createSettingsValidationMotion(container, options);
  let currentErrors = new Map<string, HTMLElement>();
  let releaseFeedback: ReturnType<typeof registerNativeControlFeedback> | undefined;
  const cleanups: (() => void)[] = [];
  const restoreChoices = new Map<string, (value: string | null) => void>();
  const restoreToggles = new Map<string, (checked: boolean, mixed: boolean) => void>();

  const render = (): Map<string, HTMLElement> => {
    const controls = options.controls();
    const fragment = createStyleMenuContent({
      workScheduler: options.workScheduler,
      ...(options.t === undefined ? {} : { t: options.t }),
      controlDescriptions: options.descriptions,
      controls,
      fontPreviews: options.fontPreviews,
      fontManagementAction: options.fontManagementAction,
      keymap: options.keymap,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      registerChoiceRestore: (id, restore) => restoreChoices.set(id, restore),
      registerToggleRestore: (id, restore) => restoreToggles.set(id, restore),
      numberInputMode: "reject",
      onChange: (controlId, value) => {
        const error = currentErrors.get(controlId);
        void writes.run(controlId, () => options.onChange(controlId, value), {
          error: (message) => {
            if (error !== undefined) validation.set(error, message);
          },
          restore: () => {
            restoreControlValues(container, options.controls(), restoreChoices, restoreToggles);
            releaseFeedback?.refresh();
          },
        });
      },
      ownerDocument: options.ownerDocument,
      onInvalidValue: (controlId) => {
        writes.invalidate(controlId);
        const error = currentErrors.get(controlId);
        if (error !== undefined)
          validation.set(
            error,
            (options.t ?? createEnglishLocalization().t)("settings.invalidValue"),
          );
      },
      renderIcon: (element, icon) => setIcon(element, icon),
    });
    const errors = installControlAccessibility(fragment, controls, options.idPrefix);
    currentErrors = errors;
    releaseFeedback?.();
    container.replaceChildren(fragment);
    releaseFeedback = registerNativeControlFeedback(container, options);
    return errors;
  };

  render();
  return () => {
    writes.dispose();
    releaseFeedback?.();
    releaseFeedback = undefined;
    validation.dispose();
    for (const cleanup of cleanups) cleanup();
  };
}

function installControlAccessibility(
  fragment: DocumentFragment,
  controls: readonly StyleControl[],
  idPrefix: string,
): Map<string, HTMLElement> {
  const errors = new Map<string, HTMLElement>();
  for (const control of controls) {
    const section = fragment.querySelector<HTMLElement>(`[data-control="${control.id}"]`);
    if (section === null) continue;
    section.classList.add("inkbook-settings-validation-surface");
    const description = section.querySelector<HTMLElement>(".inkbook-menu-control-description");
    const error = section.createDiv({ cls: "inkbook-settings-control-error" });
    const descriptionId = `${idPrefix}-${control.id}-description`;
    const errorId = `${idPrefix}-${control.id}-error`;
    if (description !== null) description.id = descriptionId;
    error.id = errorId;
    error.hidden = true;
    error.setAttribute("aria-live", "polite");
    const describedBy = description === null ? errorId : `${descriptionId} ${errorId}`;
    for (const element of section.querySelectorAll<HTMLElement>("button, input")) {
      element.setAttribute("aria-describedby", describedBy);
    }
    errors.set(control.id, error);
  }
  return errors;
}

function restoreControlValues(
  container: HTMLElement,
  controls: readonly StyleControl[],
  restoreChoices: ReadonlyMap<string, (value: string | null) => void>,
  restoreToggles: ReadonlyMap<string, (checked: boolean, mixed: boolean) => void>,
): void {
  for (const control of controls) {
    const section = container.querySelector<HTMLElement>(`[data-control="${control.id}"]`);
    if (section === null) continue;
    if (control.kind === "choice") {
      if (restoreChoices.has(control.id)) {
        restoreChoices.get(control.id)!(control.value);
        continue;
      }
      for (const button of section.querySelectorAll<HTMLButtonElement>("button[data-value]")) {
        button.setAttribute("aria-pressed", String(button.dataset.value === control.value));
      }
    } else if (control.kind === "toggle" && restoreToggles.has(control.id)) {
      restoreToggles.get(control.id)!(control.checked, control.mixed === true);
    } else {
      restoreInputs(section, control);
    }
  }
}

function restoreInputs(
  section: HTMLElement,
  control: Exclude<StyleControl, { kind: "choice" }>,
): void {
  for (const input of section.querySelectorAll<HTMLInputElement>("input")) {
    if (control.kind === "toggle") input.checked = control.checked;
    else {
      const scale = control.id.includes("opacity") ? 100 : 1;
      input.value =
        control.value === null
          ? ""
          : input.type === "number"
            ? formatStyleNumber(control.value * scale, control.id)
            : String(control.value * scale);
      input.defaultValue = input.value;
    }
  }
}
