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
  const dependentMotions = new Set<SettingsPanelMotion>();
  return {
    type: "group",
    heading: "Snapping",
    cls: "inkbook-snapping-group",
    items: [
      enabledDefinition(callbacks, dependentMotions),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.angles",
        "Angle snapping",
        "Snap rotations, line, arrow, and straight-highlighter directions, and coordinate-system axes to their fixed angles.",
      ),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.bends",
        "Bend snapping",
        "Snap line and arrow curves to straight or symmetric bends.",
      ),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.connections",
        "Connection snapping",
        "Snap line and arrow endpoints to semantic anchors and other endpoints.",
      ),
      dependentDefinition(
        callbacks,
        dependentMotions,
        "snapping.structures",
        "Structure snapping",
        "Snap table separators to their default and equally distributed positions.",
      ),
      resetAction("Reset group to defaults", callbacks.reset),
    ],
  };
}

function enabledDefinition(
  callbacks: SnappingGroupCallbacks,
  dependentMotions: ReadonlySet<SettingsPanelMotion>,
): SettingDefinitionRender {
  return {
    name: "Enable snapping",
    desc: "Enable all configured snapping behavior.",
    render: (setting) => {
      return renderSnappingToggle(setting, callbacks, "snapping.enabled", "Enable snapping", () => {
        const enabled = callbacks.get("snapping.enabled") === true;
        for (const motion of dependentMotions) motion.setExpanded(enabled);
      });
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
  const writes = new SettingsWriteFeedback();
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
