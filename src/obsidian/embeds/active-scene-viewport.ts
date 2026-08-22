import type { SceneViewport } from "../../rendering/scene/types";
import { browserScrollMetrics, type BrowserScrollElement } from "../scrolling/index";
import { measureElementBox } from "./active-editor/element-content-box";

interface SceneRect {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

interface ScrollOwnerWithClientWidth extends BrowserScrollElement {
  readonly clientWidth: number;
}

export function readActiveSceneViewport(
  container: HTMLElement,
  scrollOwner: BrowserScrollElement,
): SceneViewport {
  const containerBounds = measureElementBox(container).contentBox;
  const containerWidth = Math.max(0, containerBounds.width);
  const containerHeight = Math.max(0, containerBounds.height);
  const ownerViewport = readScrollOwnerViewport(scrollOwner);
  const left = clamp(ownerViewport.left - containerBounds.left, 0, containerWidth);
  const right = clamp(ownerViewport.right - containerBounds.left, 0, containerWidth);
  const top = clamp(ownerViewport.top - containerBounds.top, 0, containerHeight);
  const bottom = clamp(ownerViewport.bottom - containerBounds.top, 0, containerHeight);
  return {
    height: Math.max(0, bottom - top),
    left,
    top,
    width: Math.max(0, right - left),
  };
}

function readScrollOwnerViewport(scrollOwner: BrowserScrollElement): SceneRect {
  const bounds = scrollOwner.getBoundingClientRect();
  const clientWidth = (scrollOwner as Partial<ScrollOwnerWithClientWidth>).clientWidth;
  const width = positiveOrFallback(clientWidth ?? 0, bounds.width);
  const height = positiveOrFallback(
    browserScrollMetrics.getClientHeight(scrollOwner),
    bounds.height,
  );
  if (scrollOwner.ownerDocument.scrollingElement === scrollOwner) {
    const ownerWindow = scrollOwner.ownerDocument.defaultView;
    return {
      bottom: positiveOrFallback(height, ownerWindow?.innerHeight ?? bounds.height),
      left: 0,
      right: positiveOrFallback(width, ownerWindow?.innerWidth ?? bounds.width),
      top: 0,
    };
  }
  return {
    bottom: bounds.top + height,
    left: bounds.left,
    right: bounds.left + width,
    top: bounds.top,
  };
}

function positiveOrFallback(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : Math.max(0, fallback);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
