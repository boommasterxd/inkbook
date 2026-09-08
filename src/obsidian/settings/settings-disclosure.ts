import { Platform, setIcon } from "obsidian";

export interface SettingsDisclosure {
  readonly content: HTMLElement;
  readonly panel: HTMLElement;
  readonly trigger: HTMLButtonElement;
}

export interface SettingsDisclosureOptions {
  readonly contentClass?: string;
  readonly description: string;
  readonly expanded: boolean;
  readonly panelId: string;
  readonly sectionClass?: string;
  readonly title: string;
  readonly triggerClass?: string;
}

export function createSettingsDisclosure(
  container: HTMLElement,
  options: SettingsDisclosureOptions,
): SettingsDisclosure {
  const section = container.createEl("section", { cls: "inkbook-settings-tool-section" });
  if (options.sectionClass !== undefined) section.classList.add(options.sectionClass);
  const trigger = section.createEl("button", { cls: "inkbook-settings-tool-trigger" });
  if (options.triggerClass !== undefined) trigger.classList.add(options.triggerClass);
  if (Platform.isMobile) trigger.classList.add("inkbook-settings-tool-trigger-touch");
  const descriptionId = `${options.panelId}-description`;
  trigger.type = "button";
  trigger.setAttribute("aria-controls", options.panelId);
  trigger.setAttribute("aria-describedby", descriptionId);
  trigger.setAttribute("aria-expanded", String(options.expanded));
  trigger.createSpan({ cls: "inkbook-settings-tool-title", text: options.title });
  const accessibleDescription = trigger.createSpan({
    cls: "inkbook-menu-visually-hidden",
    text: options.description,
  });
  accessibleDescription.id = descriptionId;
  const chevron = trigger.createSpan({ cls: "inkbook-settings-tool-chevron" });
  setIcon(chevron, "chevron-right");

  const panel = section.createDiv({ cls: "inkbook-settings-tool-panel" });
  panel.id = options.panelId;
  panel.hidden = !options.expanded;
  panel.inert = !options.expanded;
  const content = panel.createDiv({ cls: "inkbook-settings-tool-panel-content" });
  if (options.contentClass !== undefined) content.classList.add(options.contentClass);
  content.createEl("p", {
    cls: "inkbook-settings-tool-description",
    text: options.description,
  });
  return { content, panel, trigger };
}
