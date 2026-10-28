import type {
  Setting,
  SettingDefinitionControl,
  SettingDefinitionItem,
  SettingDefinitionRender,
  SettingGroupItem,
  SettingTab,
} from "obsidian";

import type { NativeControlFeedbackOptions } from "../menus/feedback/native-control-feedback";
import { nameSettingToggle } from "./settings-row";
import { createSettingsWriteError, SettingsWriteFeedback } from "./settings-write-feedback";

export interface SettingsControlHost extends Pick<
  SettingTab,
  "getControlValue" | "setControlValue"
> {
  readonly settingsFeedback?: NativeControlFeedbackOptions;
}

/** Keeps native settings on the same asynchronous write/recovery path as the modal. */
export function nativeSettingDefinitions<K extends string>(
  definitions: readonly SettingDefinitionItem<K>[],
  host: SettingsControlHost,
  lifetime?: AbortSignal,
): SettingDefinitionItem<K>[] {
  return definitions.map((definition) => {
    if ("type" in definition && definition.type !== "page" && definition.items !== undefined) {
      return {
        ...definition,
        items: definition.items.map((item) => nativeGroupItem(item, host, lifetime)),
      };
    }
    if ("type" in definition && definition.type !== "page") return definition;
    return nativeGroupItem(definition, host, lifetime);
  });
}

function nativeGroupItem<K extends string>(
  definition: SettingGroupItem<K>,
  host: SettingsControlHost,
  lifetime: AbortSignal | undefined,
): SettingGroupItem<K> {
  if ("type" in definition) {
    return definition.items === undefined
      ? definition
      : { ...definition, items: nativeSettingDefinitions(definition.items, host, lifetime) };
  }
  return definition.control === undefined
    ? definition
    : nativeControlDefinition(definition, host, lifetime);
}

function nativeControlDefinition(
  definition: SettingDefinitionControl,
  host: SettingsControlHost,
  lifetime: AbortSignal | undefined,
): SettingDefinitionRender {
  const { control, ...metadata } = definition;
  const optionLabels = control.type === "dropdown" ? Object.values(control.options) : [];
  return {
    ...metadata,
    aliases: [...(definition.aliases ?? []), ...optionLabels],
    render: (setting) => {
      const release = renderSettingControl(setting, definition, host, () => undefined);
      const disabled = control.disabled;
      setting.setDisabled(typeof disabled === "function" ? disabled() : disabled === true);
      const ownerWindow = setting.settingEl.ownerDocument.defaultView;
      let disposed = false;
      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        ownerWindow?.removeEventListener("pagehide", dispose);
        lifetime?.removeEventListener("abort", dispose);
        release();
      };
      ownerWindow?.addEventListener("pagehide", dispose, { once: true });
      lifetime?.addEventListener("abort", dispose, { once: true });
      if (lifetime?.aborted === true) dispose();
      return dispose;
    },
  };
}

export function renderSettingControl(
  setting: Setting,
  definition: SettingDefinitionControl,
  host: SettingsControlHost,
  onChanged: (key: string) => void,
): () => void {
  const control = definition.control;
  const options = host.settingsFeedback ?? { readMotion: () => "system" as const };
  const writes = new SettingsWriteFeedback();
  const error = createSettingsWriteError(setting.settingEl, options);
  let restore = (): void => undefined;
  const commit = (value: unknown): void => {
    void writes.run(control.key, () => host.setControlValue(control.key, value), {
      error: error.set,
      restore: () => restore(),
      saved: () => onChanged(control.key),
    });
  };
  setting.settingEl.classList.add("inkbook-setting-control-row");
  setting.settingEl.classList.toggle("inkbook-setting-stacked-control", control.type !== "toggle");
  setting.infoEl.classList.add("inkbook-setting-info");
  setting.controlEl.classList.add("inkbook-setting-controls");
  if (control.type === "toggle") {
    setting.addToggle((toggle) => {
      nameSettingToggle(toggle.toggleEl, definition.name);
      error.associate(toggle.toggleEl);
      restore = () => {
        toggle.setValue(host.getControlValue(control.key) === true);
      };
      restore();
      toggle.onChange(commit);
    });
  } else if (control.type === "dropdown") {
    setting.addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute("aria-label", definition.name);
      error.associate(dropdown.selectEl);
      dropdown.addOptions(control.options);
      restore = () => {
        dropdown.setValue(String(host.getControlValue(control.key)));
      };
      restore();
      dropdown.onChange(commit);
    });
  } else if (control.type === "folder" || control.type === "text") {
    setting.addText((text) => {
      text.inputEl.setAttribute("aria-label", definition.name);
      error.associate(text.inputEl);
      restore = () => {
        const value = host.getControlValue(control.key);
        text.setValue(typeof value === "string" ? value : "");
      };
      restore();
      if (control.placeholder !== undefined) text.setPlaceholder(control.placeholder);
      text.onChange((value) => {
        let committed = false;
        void writes.run(
          control.key,
          async (isCurrent): Promise<void> => {
            const message = await control.validate?.(value);
            if (!isCurrent()) return;
            if (message !== undefined && message !== "") {
              error.set(message);
              return;
            }
            await host.setControlValue(control.key, value);
            committed = true;
          },
          {
            error: error.set,
            restore: () => restore(),
            saved: () => {
              if (committed) onChanged(control.key);
            },
          },
        );
      });
    });
  }
  return () => {
    writes.dispose();
    error.dispose();
  };
}
