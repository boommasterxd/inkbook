import {
  normalizeWheelVector,
  TRACKPAD_ZOOM_DELTA_LIMIT,
  type WheelDeltaMode,
} from "../../../editor/zoom/index";
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

export function isContinuousZoomWheel(event: ActiveEditorWheelInput): boolean {
  return (
    (event.ctrlKey === true || event.metaKey === true) &&
    wheelDeltaMode(event.deltaMode) === 0 &&
    Math.abs(event.deltaY) < TRACKPAD_ZOOM_DELTA_LIMIT &&
    Math.abs(event.deltaX ?? 0) < TRACKPAD_ZOOM_DELTA_LIMIT
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
