import type { WheelDeltaMode } from "../../../editor/zoom/index";
import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";

import type { ActiveEditorViewState, ActiveEditorWheelInput } from "./navigation";
import type { NavigationLayoutRead } from "./navigation-layout";

export function wheelDeltaMode(deltaMode: number): WheelDeltaMode {
  return deltaMode === 1 || deltaMode === 2 ? deltaMode : 0;
}

export function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function horizontalWheelDelta(
  shifted: boolean,
  deltaX: number,
  deltaY: number,
): number | undefined {
  if (shifted) {
    const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    return delta === 0 ? undefined : delta;
  }
  return deltaX !== 0 && Math.abs(deltaX) >= 1.25 * Math.abs(deltaY) ? deltaX : undefined;
}

export function isZoomWheel(event: ActiveEditorWheelInput): boolean {
  if (event.ctrlKey === true || event.metaKey === true) return true;
  return (
    event.ctrlKey === undefined &&
    event.metaKey === undefined &&
    event.shiftKey === undefined &&
    event.deltaX === undefined
  );
}

export function projectedScrollBounds(
  owner: BrowserScrollElement,
  layout: NavigationLayoutRead,
  blockSize: number,
) {
  const currentScrollHeight = browserScrollMetrics.getScrollHeight(owner);
  const clientHeight = browserScrollMetrics.getClientHeight(owner);
  const heightDelta = blockSize - layout.containerBorderBounds.height;
  return {
    min: 0,
    max: Math.max(0, currentScrollHeight + heightDelta - clientHeight),
  };
}

export function validViewState(state: ActiveEditorViewState): boolean {
  return Number.isFinite(state.cameraX) && Number.isFinite(state.zoom) && state.zoom > 0;
}
