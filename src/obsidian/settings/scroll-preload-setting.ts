import type { SettingDefinitionRender } from "obsidian";

import { MAX_SCROLL_PRELOAD_MARGIN_PX, MIN_SCROLL_PRELOAD_MARGIN_PX } from "../../domain/settings";
import type { SettingsControlKey } from "./control-values";
import { renderSettingsControlContent } from "./settings-control-content";

const DESCRIPTION =
  "Prepare existing strokes within this many screen pixels above and below the visible area. " +
  "Higher values can reduce visible loading while scrolling, but use more memory and preparation work. " +
  "Lower values preload less. Large jumps can still require loading. " +
  "Saved only for this device and vault.";

interface ScrollPreloadValues {
  readonly get: (key: SettingsControlKey) => unknown;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

export function scrollPreloadDefinition(values: ScrollPreloadValues): SettingDefinitionRender {
  return {
    name: "Scroll preload margin",
    desc: DESCRIPTION,
    render: (setting) => {
      setting.settingEl.replaceChildren();
      setting.settingEl.classList.add("inkbook-settings-visual-row");
      const info = setting.settingEl.createDiv({ cls: "inkbook-settings-visual-info" });
      info.createDiv({ cls: "setting-item-name", text: "Scroll preload margin" });
      info.createDiv({ cls: "setting-item-description", text: DESCRIPTION });
      const content = setting.settingEl.createDiv({ cls: "inkbook-settings-inline-controls" });
      renderSettingsControlContent(content, {
        controls: () => [
          {
            id: "scroll-preload-margin",
            kind: "number",
            label: "Screen pixels",
            min: MIN_SCROLL_PRELOAD_MARGIN_PX,
            max: MAX_SCROLL_PRELOAD_MARGIN_PX,
            step: 1,
            value: Number(values.get("device.scrollPreloadMarginPx")),
          },
        ],
        descriptions: { "scroll-preload-margin": "Choose a whole number from 100 to 800 pixels." },
        idPrefix: "inkbook-setting-scroll-preload",
        onChange: (_controlId, value) => values.set("device.scrollPreloadMarginPx", value),
        ownerDocument: setting.settingEl.ownerDocument,
      });
    },
  };
}
