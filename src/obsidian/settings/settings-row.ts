import type { Setting, SettingDefinitionGroup } from "obsidian";

export type InkbookSettingActionTone = "caution" | "danger";

export interface SettingsRow {
  readonly control: HTMLElement;
  readonly info: HTMLElement;
  readonly row: HTMLElement;
}

export interface SettingsRowOptions {
  readonly className?: string;
  readonly description?: string;
  readonly name: string;
}

export function settingsGroupIdentity(
  definition: Pick<SettingDefinitionGroup, "cls" | "heading">,
): string {
  return JSON.stringify([definition.cls ?? null, definition.heading ?? null]);
}

export function nameSettingToggle(toggleElement: HTMLElement, name: string): void {
  const control =
    toggleElement.tagName === "LABEL" ? (toggleElement as HTMLLabelElement).control : toggleElement;
  control?.setAttribute("aria-label", name);
}

export function createSettingsRow(
  container: HTMLElement,
  options: SettingsRowOptions,
): SettingsRow {
  const row = container.createDiv({ cls: "setting-item" });
  if (options.className !== undefined) row.classList.add(options.className);
  const info = row.createDiv({ cls: "setting-item-info" });
  info.createDiv({ cls: "setting-item-name", text: options.name });
  if (options.description !== undefined) {
    info.createDiv({ cls: "setting-item-description", text: options.description });
  }
  const control = row.createDiv({ cls: "setting-item-control" });
  return { control, info, row };
}

export function createSettingsHeading(
  container: HTMLElement,
  name: string,
  description: string,
): HTMLElement {
  const info = container.createDiv({ cls: "inkbook-settings-visual-info" });
  info.createDiv({ cls: "setting-item-name", text: name });
  const descriptionElement = info.createDiv({ cls: "setting-item-description", text: description });
  descriptionElement.id = `inkbook-setting-${name.toLowerCase().replaceAll(" ", "-")}-description`;
  return descriptionElement;
}

export function createSettingsVisualControlRow(
  setting: Setting,
  name: string,
  description: string,
): HTMLElement {
  setting.settingEl.replaceChildren();
  setting.settingEl.classList.add("inkbook-settings-visual-row");
  createSettingsHeading(setting.settingEl, name, description);
  return setting.settingEl.createDiv({ cls: "inkbook-settings-inline-controls" });
}

export function bindSettingsAction(
  element: HTMLElement,
  activate: () => void,
  tone?: InkbookSettingActionTone,
): () => void {
  element.classList.add("mod-action", "tappable");
  element.dataset.inkbookSettingActionTone = tone ?? "neutral";
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  };
  element.addEventListener("click", activate);
  element.addEventListener("keydown", onKeyDown);
  return () => {
    element.removeEventListener("click", activate);
    element.removeEventListener("keydown", onKeyDown);
  };
}
