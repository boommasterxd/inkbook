import { createEnglishLocalization, type Translator } from "../../../domain/localization";
import type { ObserveMotion } from "../../runtime/effective-motion";
import type { Setting, SettingDefinitionGroup, SettingDefinitionRender } from "obsidian";

import type { InkbookDeviceSettingsV2 } from "../../../domain/settings";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { SettingsControlKey } from "../control-values";
import { resetAction } from "./definition-helpers";
import { SettingsPanelMotion } from "../settings-panel-motion";
import { nameSettingToggle } from "../settings-row";
import { createSettingsWriteError, SettingsWriteFeedback } from "../settings-write-feedback";

export interface SnappingGroupCallbacks {
  readonly t?: Translator;
  readonly observeMotion?: ObserveMotion;
  readonly workScheduler: (ownerWindow: Window | null) => WorkScheduler;
  readonly get: (key: SettingsControlKey) => unknown;
  readonly readMotion: () => InkbookDeviceSettingsV2["motion"];
  readonly reset: () => void | Promise<void>;
  readonly set: (key: SettingsControlKey, value: unknown) => Promise<void>;
}

export function snappingGroup(
  callbacks: SnappingGroupCallbacks,
): SettingDefinitionGroup<SettingsControlKey> {
  const t = callbacks.t ?? createEnglishLocalization().t;
  const dependentMotions = new Set<SettingsPanelMotion>();
  return {
    type: "group",
    heading: t("settings.controls.snapping"),
    cls: "inkbook-snapping-group",
    items: [
      enabledDefinition(callbacks, dependentMotions),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.angles",
        t("settings.controls.angleSnapping"),
        t("settings.controls.angleSnappingHelp"),
      ),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.bends",
        t("settings.controls.bendSnapping"),
        t("settings.controls.bendSnappingHelp"),
      ),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.connections",
        t("settings.controls.connectionSnapping"),
        t("settings.controls.connectionSnappingHelp"),
      ),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.structures",
        t("settings.controls.structureSnapping"),
        t("settings.controls.structureSnappingHelp"),
      ),
      resetAction(t("settings.controls.resetGroup"), callbacks.reset, t),
    ],
  };
}

function enabledDefinition(
  callbacks: SnappingGroupCallbacks,
  dependentMotions: ReadonlySet<SettingsPanelMotion>,
): SettingDefinitionRender {
  const t = callbacks.t ?? createEnglishLocalization().t;
  return {
    name: t("settings.controls.snappingEnabled"),
    desc: t("settings.controls.snappingEnabledHelp"),
    render: (setting) => {
      return renderSnappingToggle(
        setting,
        callbacks,
        "snapping.enabled",
        t("settings.controls.snappingEnabled"),
        () => {
          const enabled = callbacks.get("snapping.enabled") === true;
          for (const motion of dependentMotions) motion.setExpanded(enabled);
        },
      );
    },
  };
}

function dependentDefinition(
  callbacks: SnappingGroupCallbacks,
  dependentMotions: Set<SettingsPanelMotion>,
  key: SettingsControlKey,
  name: string,
  desc: string,
): SettingDefinitionRender {
  return {
    name,
    desc,
    render: (setting) => renderDependentToggle(setting, callbacks, dependentMotions, key, name),
  };
}

function renderDependentToggle(
  setting: Setting,
  callbacks: SnappingGroupCallbacks,
  dependentMotions: Set<SettingsPanelMotion>,
  key: SettingsControlKey,
  name: string,
): () => void {
  const row = setting.settingEl;
  row.classList.add("inkbook-snapping-dependent-row");
  const enabled = callbacks.get("snapping.enabled") === true;
  row.hidden = !enabled;
  row.inert = !enabled;
  const releaseToggle = renderSnappingToggle(setting, callbacks, key, name);
  const motion = new SettingsPanelMotion(row, callbacks.readMotion, callbacks.observeMotion);
  dependentMotions.add(motion);
  return () => {
    dependentMotions.delete(motion);
    motion.dispose();
    releaseToggle();
  };
}

function renderSnappingToggle(
  setting: Setting,
  callbacks: SnappingGroupCallbacks,
  key: SettingsControlKey,
  name: string,
  saved?: () => void,
): () => void {
  const writes = new SettingsWriteFeedback(callbacks.t);
  const error = createSettingsWriteError(setting.settingEl, callbacks);
  setting.addToggle((toggle) => {
    nameSettingToggle(toggle.toggleEl, name);
    error.associate(toggle.toggleEl);
    const restore = (): void => {
      toggle.setValue(callbacks.get(key) === true);
      saved?.();
    };
    restore();
    toggle.onChange((value) => {
      void writes.run(key, () => callbacks.set(key, value), {
        error: error.set,
        restore,
        ...(saved === undefined ? {} : { saved }),
      });
    });
  });
  return () => {
    writes.dispose();
    error.dispose();
  };
}
