import { createEnglishLocalization, type Translator } from "../../../domain/localization";
import type { SettingDefinitionGroup } from "obsidian";

import { REFRESH_RATE_PREFERENCES } from "../../../domain/settings";
import type { RefreshRateProfileStatus } from "../../performance";
import type { SettingsControlKey } from "../control-values";
import { dropdown, resetAction, toggle } from "./definition-helpers";
import { scrollPreloadDefinition } from "./scroll-preload-setting";
import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";

interface PerformanceGroupCallbacks extends NativeControlFeedbackOptions {
  readonly t?: Translator;
  readonly get: (key: SettingsControlKey) => unknown;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
  readonly refreshRateStatus: () => RefreshRateProfileStatus;
  readonly reset: () => void | Promise<void>;
}

export function performanceGroup(
  callbacks: PerformanceGroupCallbacks,
): SettingDefinitionGroup<SettingsControlKey> {
  const t = callbacks.t ?? createEnglishLocalization().t;
  const status = callbacks.refreshRateStatus();
  return {
    type: "group",
    heading: t("settings.controls.performance"),
    cls: "inkbook-settings-performance-group",
    items: [
      dropdown(
        "refreshRatePreference",
        t("settings.controls.refreshRate"),
        refreshRateDescription(status, t),
        Object.fromEntries(
          REFRESH_RATE_PREFERENCES.map((value) => [
            String(value),
            value === "auto"
              ? autoRefreshRateLabel(status, t)
              : t("settings.controls.hertz", { value }),
          ]),
        ),
      ),
      scrollPreloadDefinition(callbacks),
      toggle(
        "selectionHighlightsEnabled",
        t("settings.controls.selectionHighlights"),
        t("settings.controls.selectionHighlightsHelp"),
      ),
      resetAction(t("settings.controls.resetGroup"), callbacks.reset, t),
    ],
  };
}

function autoRefreshRateLabel(status: RefreshRateProfileStatus, t: Translator): string {
  if (status.kind === "detected")
    return t("settings.controls.autoDetected", { rate: status.refreshRate });
  if (status.kind === "detecting") return t("settings.controls.autoDetecting");
  return t("settings.controls.auto");
}

function refreshRateDescription(status: RefreshRateProfileStatus, t: Translator): string {
  const profileDescription = t("settings.controls.profileHelp");
  if (status.kind === "detected") {
    return t("settings.controls.refreshDetectedHelp", {
      rate: status.refreshRate,
      profileDescription,
    });
  }
  if (status.kind === "detecting") {
    return t("settings.controls.refreshDetectingHelp", { profileDescription });
  }
  return t("settings.controls.refreshFallbackHelp", { profileDescription });
}
