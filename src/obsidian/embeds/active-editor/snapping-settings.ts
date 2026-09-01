import type { SnappingSettingsV1 } from "../../../domain/settings/types";
import type { SelectionSnapFeatures } from "../../../editor/selection/public";

const DEFAULT_SNAPPING: Readonly<SnappingSettingsV1> = Object.freeze({
  angles: true,
  bends: true,
  connections: true,
  enabled: true,
  structures: true,
});

export function activeSnapFeatures(
  settings?: SnappingSettingsV1,
  inverted = false,
): SelectionSnapFeatures {
  const current = settings ?? DEFAULT_SNAPPING;
  const enabled = inverted ? !current.enabled : current.enabled;
  return {
    angles: enabled && current.angles,
    bends: enabled && current.bends,
    connections: enabled && current.connections,
    structures: enabled && current.structures,
  };
}
