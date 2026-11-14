import {
  SettingGroup,
  type Setting,
  type SettingDefinition,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
} from "obsidian";

import { bindSettingsAction, settingsGroupIdentity } from "./settings-row";
import { renderSettingControl, type SettingsControlHost } from "./setting-control-renderer";
import { createSettingsWriteError, SettingsWriteFeedback } from "./settings-write-feedback";

export class SettingDefinitionRenderer {
  readonly #cleanups: (() => void)[] = [];
  readonly #host: SettingsControlHost;
  readonly #onChanged: (key: string | undefined) => void;

  public constructor(host: SettingsControlHost, onChanged: (key: string | undefined) => void) {
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
    const items = (definition.items ?? []).flatMap((item, index) =>
      !isPage(item) && visible(item) ? [{ item, index }] : [],
    );
    if (
      definition.heading === undefined &&
      items.length === 0 &&
      definition.search === undefined &&
      (definition.extraButtons?.length ?? 0) === 0
    )
      return;
    const group = new SettingGroup(container);
    if (definition.heading !== undefined) group.setHeading(definition.heading);
    if (definition.cls !== undefined) group.addClass(definition.cls);
    for (const { item, index } of items)
      this.#renderDefinition(group, item, index, settingsGroupIdentity(definition));
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
        definition.control?.key ?? index,
      ]);
      if (definition.desc !== undefined) setting.setDesc(definition.desc);
      if (definition.render !== undefined) {
        const cleanup = definition.render(setting, group);
        if (typeof cleanup === "function") this.#cleanups.push(cleanup);
      } else if (definition.action !== undefined) {
        this.#renderAction(setting, definition, index);
      } else if (definition.control !== undefined) {
        this.#cleanups.push(renderSettingControl(setting, definition, this.#host, this.#onChanged));
      }
      if (definition.control !== undefined && disabled(definition.control)) {
        setting.setDisabled(true);
      }
      if (definition.action !== undefined && disabled(definition)) setting.setDisabled(true);
    });
  }

  #renderAction(setting: Setting, definition: SettingDefinition, index: number): void {
    if (definition.action === undefined) return;
    const element = setting.settingEl;
    const writes = new SettingsWriteFeedback(this.#host.settingsFeedback?.t);
    const error = createSettingsWriteError(
      element,
      this.#host.settingsFeedback ?? {
        readMotion: () => "system",
      },
    );
    error.associate(element);
    const activate = (): void => {
      void writes.run("action", () => definition.action?.(element, index), {
        error: error.set,
        restore: () => undefined,
        saved: () => this.#onChanged(undefined),
      });
    };
    this.#cleanups.push(bindSettingsAction(element, activate));
    this.#cleanups.push(() => {
      writes.dispose();
      error.dispose();
    });
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
