import type { SelectionSnapFeatures, SelectionSnapPorts } from "./handle-types";

export function selectionSnapFeatureEnabled(
  snap: SelectionSnapPorts | undefined,
  feature: keyof SelectionSnapFeatures,
): boolean {
  return snap?.features?.[feature] ?? true;
}
