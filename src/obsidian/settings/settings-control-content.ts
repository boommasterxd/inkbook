import { setIcon } from "obsidian";

import type { StyleControl } from "../menus/editor-menu-types";
import { createStyleMenuContent } from "../menus/style-menu-content";

const INVALID_VALUE_MESSAGE = "Enter a valid setting value.";
const SAVE_FAILURE_MESSAGE = "The setting could not be saved.";

export interface SettingsControlContentOptions {
  readonly controls: () => readonly StyleControl[];
  readonly descriptions: Readonly<Record<string, string>>;
  readonly idPrefix: string;
  readonly onChange: (controlId: string, value: boolean | number | string) => Promise<void>;
  readonly ownerDocument: Document;
}

export function renderSettingsControlContent(
  container: HTMLElement,
  options: SettingsControlContentOptions,
): void {
  const latestCommits = new Map<string, number>();
  let currentErrors = new Map<string, HTMLElement>();

  const render = (): Map<string, HTMLElement> => {
    const controls = options.controls();
    const fragment = createStyleMenuContent({
      controlDescriptions: options.descriptions,
      controls,
      numberInputMode: "reject",
      onChange: (controlId, value) => {
        const commit = (latestCommits.get(controlId) ?? 0) + 1;
        latestCommits.set(controlId, commit);
        clearControlError(container, controlId);
        void options.onChange(controlId, value).catch(() => {
          if (commit !== latestCommits.get(controlId)) return;
          const errors = render();
          showControlError(errors.get(controlId), SAVE_FAILURE_MESSAGE);
        });
      },
      ownerDocument: options.ownerDocument,
      onInvalidValue: (controlId) =>
        showControlError(currentErrors.get(controlId), INVALID_VALUE_MESSAGE),
      renderIcon: (element, icon) => setIcon(element, icon),
    });
    const errors = installControlAccessibility(fragment, controls, options.idPrefix);
    currentErrors = errors;
    container.replaceChildren(fragment);
    return errors;
  };

  render();
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

function clearControlError(container: HTMLElement, controlId: string): void {
  const section = container.querySelector<HTMLElement>(`[data-control="${controlId}"]`);
  const error = section?.querySelector<HTMLElement>(".inkbook-settings-control-error");
  if (error === null || error === undefined) return;
  error.textContent = "";
  error.hidden = true;
}

function showControlError(error: HTMLElement | undefined, message: string): void {
  if (error === undefined) return;
  error.textContent = message;
  error.hidden = false;
}
