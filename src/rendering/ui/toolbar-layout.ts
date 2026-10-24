export type ToolbarLayoutStage = "wide" | "scrollable";

export const TOOLBAR_CONTEXT_CORRIDOR_PX = 136;

export interface ToolbarMeasurements {
  readonly availableWidth: number;
  readonly contentWidth: number;
}

export function resolveToolbarLayout(measurements: ToolbarMeasurements): ToolbarLayoutStage {
  return measurements.contentWidth + TOOLBAR_CONTEXT_CORRIDOR_PX <= measurements.availableWidth
    ? "wide"
    : "scrollable";
}
