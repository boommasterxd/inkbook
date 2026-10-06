import { normalizeWheelVector, type WheelDeltaMode } from "../../../editor/zoom/index";
import { browserScrollMetrics, type BrowserScrollElement } from "../../scrolling/index";

import type { ActiveEditorViewState, ActiveEditorWheelInput } from "./navigation-types";
import type { NavigationLayoutRead } from "./navigation-layout";

function wheelDeltaMode(deltaMode: number): WheelDeltaMode {
  return deltaMode === 1 || deltaMode === 2 ? deltaMode : 0;
}

export function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function horizontalWheelDelta(
  shifted: boolean,
  deltaX: number,
  deltaY: number,
): number | undefined {
  if (shifted) {
    return deltaX === 0 && deltaY !== 0 ? deltaY : undefined;
  }
  return deltaX !== 0 && Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : undefined;
}

export function horizontalPanWheel(
  event: ActiveEditorWheelInput,
  normalization: { readonly pageHeight?: number },
): number | undefined {
  const delta = normalizeWheelVector(
    event.deltaX ?? 0,
    event.deltaY,
    wheelDeltaMode(event.deltaMode),
    normalization,
  );
  const horizontal = horizontalWheelDelta(event.shiftKey === true, delta.x, delta.y);
  return horizontal === undefined ? undefined : -horizontal;
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

/** Pixel units describe continuous input; magnitude cannot identify the physical device. */
export function isContinuousZoomWheel(event: ActiveEditorWheelInput): boolean {
  return (
    (event.ctrlKey === true || event.metaKey === true) && wheelDeltaMode(event.deltaMode) === 0
  );
}

export function projectedScrollBounds(
  owner: BrowserScrollElement,
  layout: NavigationLayoutRead,
  blockSize: number,
) {
  const currentScrollHeight = browserScrollMetrics.getScrollHeight(owner);
  const clientHeight = layout.ownerViewport.bottom - layout.ownerViewport.top;
  const heightDelta = blockSize - layout.containerBounds.height;
  return {
    min: 0,
    max: Math.max(0, currentScrollHeight + heightDelta - clientHeight),
  };
}

export function validViewState(state: ActiveEditorViewState): boolean {
  return Number.isFinite(state.cameraX) && Number.isFinite(state.zoom) && state.zoom > 0;
}
