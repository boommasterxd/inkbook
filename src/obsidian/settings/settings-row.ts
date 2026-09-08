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

export function bindSettingsAction(
  element: HTMLElement,
  activate: () => void,
  tone?: InkbookSettingActionTone,
): () => void {
  element.classList.add("mod-action", "tappable");
  if (tone !== undefined) element.dataset.inkbookSettingActionTone = tone;
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
