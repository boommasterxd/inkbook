export type ToolbarLayoutStage = "wide" | "merged" | "scrollable";

export const LEFT_HANDED_TOOL_TRANSLATION_PX = -22;

export interface ToolbarMeasurements {
  readonly availableWidth: number;
  readonly centerWidth: number;
  readonly centerTranslation?: number;
  readonly leftWidth: number;
  readonly mergedWidth: number;
  readonly rightWidth: number;
}

export function resolveToolbarLayout(measurements: ToolbarMeasurements): ToolbarLayoutStage {
  const centerTranslation = measurements.centerTranslation ?? 0;
  const leftRequirement =
    measurements.centerWidth + 2 * measurements.leftWidth + 32 - 2 * centerTranslation;
  const rightRequirement =
    measurements.centerWidth + 2 * measurements.rightWidth + 32 + 2 * centerTranslation;
  if (Math.max(leftRequirement, rightRequirement) <= measurements.availableWidth) {
    return "wide";
  }
  return measurements.mergedWidth <= measurements.availableWidth ? "merged" : "scrollable";
}
