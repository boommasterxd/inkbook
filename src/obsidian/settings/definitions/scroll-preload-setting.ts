import { createEnglishLocalization, type Translator } from "../../../domain/localization";
import type { SettingDefinitionRender } from "obsidian";

import {
  MAX_SCROLL_PRELOAD_MARGIN_PX,
  MIN_SCROLL_PRELOAD_MARGIN_PX,
} from "../../../domain/settings";
import type { SettingsControlKey } from "../control-values";
import { renderSettingsControlContent } from "../settings-control-content";
import { createSettingsVisualControlRow } from "../settings-row";
import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";

interface ScrollPreloadValues extends NativeControlFeedbackOptions {
  readonly t?: Translator;
  readonly get: (key: SettingsControlKey) => unknown;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

export function scrollPreloadDefinition(values: ScrollPreloadValues): SettingDefinitionRender {
  const t = values.t ?? createEnglishLocalization().t;
  return {
    name: t("settings.controls.scrollPreload"),
    desc: t("settings.controls.scrollPreloadHelp"),
    render: (setting) => {
      const content = createSettingsVisualControlRow(
        setting,
        t("settings.controls.scrollPreload"),
        t("settings.controls.scrollPreloadHelp"),
      );
      return renderSettingsControlContent(content, {
        ...(values.t === undefined ? {} : { t: values.t }),
        controls: () => [
          {
            id: "scroll-preload-margin",
            kind: "number",
            label: t("settings.controls.screenPixels"),
            min: MIN_SCROLL_PRELOAD_MARGIN_PX,
            max: MAX_SCROLL_PRELOAD_MARGIN_PX,
            step: 1,
            value: Number(values.get("device.scrollPreloadMarginPx")),
          },
        ],
        descriptions: { "scroll-preload-margin": t("settings.controls.scrollPixelsHelp") },
        idPrefix: "inkbook-setting-scroll-preload",
        onChange: (_controlId, value) => values.set("device.scrollPreloadMarginPx", value),
        ownerDocument: setting.settingEl.ownerDocument,
        readMotion: values.readMotion,
        ...(values.observeMotion === undefined ? {} : { observeMotion: values.observeMotion }),
      });
    },
  };
}
