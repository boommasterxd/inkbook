import {
  SettingGroup,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionControl,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingTab,
} from "obsidian";

import { bindSettingsAction, nameSettingToggle } from "./settings-row";

export class SettingDefinitionRenderer {
  readonly #cleanups: (() => void)[] = [];
  readonly #host: Pick<SettingTab, "getControlValue" | "setControlValue">;
  readonly #onChanged: (key: string | undefined) => void;

  public constructor(
    host: Pick<SettingTab, "getControlValue" | "setControlValue">,
    onChanged: (key: string | undefined) => void,
  ) {
    this.#host = host;
    this.#onChanged = onChanged;
  }

  public dispose(): void {
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
  }

  public render(container: HTMLElement, definitions: readonly SettingDefinitionItem[]): void {
    this.dispose();
    container.replaceChildren();
    for (const definition of definitions) this.#renderItem(container, definition);
  }

  #renderItem(container: HTMLElement, definition: SettingDefinitionItem): void {
    if (!visible(definition)) return;
    if (isGroup(definition)) {
      this.#renderGroup(container, definition);
      return;
    }
    if (isPage(definition)) return;
    const group = new SettingGroup(container);
    this.#renderDefinition(group, definition, 0, "root");
  }

  #renderGroup(container: HTMLElement, definition: SettingDefinitionGroup): void {
    const group = new SettingGroup(container);
    if (definition.heading !== undefined) group.setHeading(definition.heading);
    if (definition.cls !== undefined) group.addClass(definition.cls);
    definition.items?.forEach((item, index) => {
      if (!isPage(item) && visible(item)) {
        this.#renderDefinition(group, item, index, definition.cls ?? definition.heading ?? "group");
      }
    });
  }

  #renderDefinition(
    group: SettingGroup,
    definition: SettingDefinition,
    index: number,
    groupIdentity: string,
  ): void {
    group.addSetting((setting) => {
      setting.setName(definition.name);
      setting.settingEl.dataset.inkbookSettingIdentity = JSON.stringify([
        groupIdentity,
        definition.control?.key ?? definition.name,
      ]);
      if (definition.desc !== undefined) setting.setDesc(definition.desc);
      if (definition.control !== undefined && disabled(definition.control)) {
        setting.setDisabled(true);
      }
      if (definition.action !== undefined && disabled(definition)) setting.setDisabled(true);
      if (definition.render !== undefined) {
        const cleanup = definition.render(setting, group);
        if (typeof cleanup === "function") this.#cleanups.push(cleanup);
      } else if (definition.action !== undefined) {
        this.#renderAction(setting, definition, index);
      } else if (definition.control !== undefined) {
        this.#renderControl(setting, definition);
      }
    });
  }

  #renderAction(setting: Setting, definition: SettingDefinition, index: number): void {
    if (definition.action === undefined) return;
    const element = setting.settingEl;
    const activate = (): void => {
      definition.action?.(element, index);
      this.#onChanged(undefined);
    };
    this.#cleanups.push(bindSettingsAction(element, activate));
  }

  #renderControl(setting: Setting, definition: SettingDefinitionControl): void {
    const control = definition.control;
    setting.settingEl.classList.add("inkbook-setting-control-row");
    setting.settingEl.classList.toggle(
      "inkbook-setting-stacked-control",
      control.type !== "toggle",
    );
    setting.infoEl.classList.add("inkbook-setting-info");
    setting.controlEl.classList.add("inkbook-setting-controls");
    const value = this.#host.getControlValue(control.key);
    if (control.type === "toggle") {
      setting.addToggle((toggle) => {
        nameSettingToggle(toggle.toggleEl, definition.name);
        toggle.setValue(value === true).onChange((next) => this.#commit(control.key, next));
      });
      return;
    }
    if (control.type === "dropdown") {
      setting.addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", definition.name);
        dropdown.addOptions(control.options).setValue(String(value));
        dropdown.onChange((next) => this.#commit(control.key, next));
      });
      return;
    }
    if (control.type === "folder" || control.type === "text") {
      setting.addText((text) => {
        text.inputEl.setAttribute("aria-label", definition.name);
        text.setValue(typeof value === "string" ? value : "");
        if (control.placeholder !== undefined) text.setPlaceholder(control.placeholder);
        text.onChange((next) => {
          void Promise.resolve(control.validate?.(next)).then((error) => {
            setting.setErrorMessage(error ?? null);
            if (error === undefined || error === "") void this.#commit(control.key, next);
          });
        });
      });
    }
  }

  async #commit(key: string, value: unknown): Promise<void> {
    await this.#host.setControlValue(key, value);
    this.#onChanged(key);
  }
}

function visible(definition: { readonly visible?: boolean | (() => boolean) }): boolean {
  return typeof definition.visible === "function"
    ? definition.visible()
    : definition.visible !== false;
}

function isGroup(definition: SettingDefinitionItem): definition is SettingDefinitionGroup {
  return "type" in definition && (definition.type === "group" || definition.type === "list");
}

function isPage(
  definition: SettingDefinitionItem | NonNullable<SettingDefinitionGroup["items"]>[number],
): boolean {
  return "type" in definition && definition.type === "page";
}

function disabled(definition: { readonly disabled?: boolean | (() => boolean) }): boolean {
  return typeof definition.disabled === "function"
    ? definition.disabled()
    : definition.disabled === true;
}
