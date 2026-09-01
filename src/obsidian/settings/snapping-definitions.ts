import type { SettingDefinitionGroup } from "obsidian";

import type { SettingsControlKey } from "./control-values";
import { resetAction, toggle } from "./definition-helpers";

export interface SnappingGroupCallbacks {
  readonly isEnabled: () => boolean;
  readonly reset: () => void;
}

export function snappingGroup(
  callbacks: SnappingGroupCallbacks,
): SettingDefinitionGroup<SettingsControlKey> {
  const visible = () => callbacks.isEnabled();
  return {
    type: "group",
    heading: "Snapping",
    items: [
      toggle("snapping.enabled", "Enable snapping", "Enable all configured snapping behavior."),
      {
        ...toggle(
          "snapping.angles",
          "Angle snapping",
          "Snap rotations, line directions, and coordinate-system axes to their fixed angles.",
        ),
        visible,
      },
      {
        ...toggle(
          "snapping.bends",
          "Bend snapping",
          "Snap line and arrow curves to straight or symmetric bends.",
        ),
        visible,
      },
      {
        ...toggle(
          "snapping.connections",
          "Connection snapping",
          "Snap line and arrow endpoints to semantic anchors and other endpoints.",
        ),
        visible,
      },
      {
        ...toggle(
          "snapping.structures",
          "Structure snapping",
          "Snap table separators to their default and equally distributed positions.",
        ),
        visible,
      },
      resetAction("Reset group to defaults", callbacks.reset),
    ],
  };
}
