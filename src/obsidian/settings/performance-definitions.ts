import type { SettingDefinitionGroup } from "obsidian";

import { REFRESH_RATE_PREFERENCES } from "../../domain/settings";
import type { RefreshRateProfileStatus } from "../performance";
import type { SettingsControlKey } from "./control-values";
import { dropdown, resetAction, toggle } from "./definition-helpers";
import { scrollPreloadDefinition } from "./scroll-preload-setting";

interface PerformanceGroupCallbacks {
  readonly get: (key: SettingsControlKey) => unknown;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
  readonly refreshRateStatus: () => RefreshRateProfileStatus;
  readonly reset: () => void;
}

export function performanceGroup(
  callbacks: PerformanceGroupCallbacks,
): SettingDefinitionGroup<SettingsControlKey> {
  const status = callbacks.refreshRateStatus();
  return {
    type: "group",
    heading: "Performance",
    cls: "inkbook-settings-performance-group",
    items: [
      dropdown(
        "refreshRatePreference",
        "Display refresh rate",
        refreshRateDescription(status),
        Object.fromEntries(
          REFRESH_RATE_PREFERENCES.map((value) => [
            String(value),
            value === "auto" ? autoRefreshRateLabel(status) : `${value} Hz`,
          ]),
        ),
      ),
      scrollPreloadDefinition(callbacks),
      toggle(
        "selectionHighlightsEnabled",
        "Selection highlights",
        "Show inner selection edge highlights. These can increase rendering work and affect performance, especially for large selections. " +
          "Disabling them reduces optional highlight work. Lines and arrows always keep their center selection trace.",
      ),
      resetAction("Reset group to defaults", callbacks.reset),
    ],
  };
}

function autoRefreshRateLabel(status: RefreshRateProfileStatus): string {
  if (status.kind === "detected") return `Auto (detected: ${status.refreshRate} Hz)`;
  if (status.kind === "detecting") return "Auto (detecting…)";
  return "Auto";
}

function refreshRateDescription(status: RefreshRateProfileStatus): string {
  const profileDescription =
    "Match the profile to your display. Higher profiles leave more frame time for smooth interaction, but loading can take longer.";
  if (status.kind === "detected") {
    return `Detected ${status.refreshRate} Hz for this Obsidian window. Other windows are measured independently. ${profileDescription}`;
  }
  if (status.kind === "detecting") {
    return `Detecting this Obsidian window. Inkbook uses the 120 Hz profile until detection completes. ${profileDescription}`;
  }
  return `Use quick per-window detection or select a fixed frame-rate profile. ${profileDescription}`;
}
