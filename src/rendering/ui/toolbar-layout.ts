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

export function toolbarMainHalfWidth(element: HTMLElement): number {
  const layoutWidth = element.offsetWidth > 0 ? element.offsetWidth : element.scrollWidth;
  const width = layoutWidth > 0 ? layoutWidth : element.getBoundingClientRect().width;
  return Math.max(0, width) / 2;
}
