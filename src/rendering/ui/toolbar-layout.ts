export type ToolbarLayoutStage = "wide" | "scrollable";

export const TOOLBAR_CONTEXT_CORRIDOR_PX = 136;
const TOOLBAR_CONTEXT_EDGE_ALLOWANCE_PX = 16;

export interface ToolbarMeasurements {
  readonly availableWidth: number;
  readonly contentWidth: number;
  readonly contextWidth?: number;
}

export function resolveToolbarLayout(measurements: ToolbarMeasurements): ToolbarLayoutStage {
  const contextCorridor = Math.max(
    TOOLBAR_CONTEXT_CORRIDOR_PX,
    2 * (Math.max(0, measurements.contextWidth ?? 0) + TOOLBAR_CONTEXT_EDGE_ALLOWANCE_PX),
  );
  return measurements.contentWidth + contextCorridor <= measurements.availableWidth
    ? "wide"
    : "scrollable";
}
