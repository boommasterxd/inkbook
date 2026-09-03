import type { Setting, SettingDefinitionGroup, SettingDefinitionRender } from "obsidian";

import type { InkbookDeviceSettingsV2 } from "../../domain/settings";
import type { SettingsControlKey } from "./control-values";
import { resetAction } from "./definition-helpers";
import { SettingsPanelMotion } from "./settings-panel-motion";

export interface SnappingGroupCallbacks {
  readonly get: (key: SettingsControlKey) => unknown;
  readonly readMotion: () => InkbookDeviceSettingsV2["motion"];
  readonly reset: () => void;
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
        "Snap rotations, line directions, and coordinate-system axes to their fixed angles.",
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
      setting.addToggle((toggle) =>
        toggle.setValue(callbacks.get("snapping.enabled") === true).onChange((enabled) => {
          void callbacks.set("snapping.enabled", enabled).then(() => {
            for (const motion of dependentMotions) motion.setExpanded(enabled);
          });
        }),
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
    render: (setting) => renderDependentToggle(setting, callbacks, dependentMotions, key),
  };
}

function renderDependentToggle(
  setting: Setting,
  callbacks: SnappingGroupCallbacks,
  dependentMotions: Set<SettingsPanelMotion>,
  key: SettingsControlKey,
): () => void {
  const row = setting.settingEl;
  row.classList.add("inkbook-snapping-dependent-row");
  const enabled = callbacks.get("snapping.enabled") === true;
  row.hidden = !enabled;
  row.inert = !enabled;
  setting.addToggle((toggle) =>
    toggle
      .setValue(callbacks.get(key) === true)
      .onChange((value) => void callbacks.set(key, value)),
  );
  const motion = new SettingsPanelMotion(row, callbacks.readMotion);
  dependentMotions.add(motion);
  return () => {
    dependentMotions.delete(motion);
    motion.dispose();
  };
}
