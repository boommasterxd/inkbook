import type { SceneViewport } from "../../rendering/scene/types";
import { browserScrollMetrics, type BrowserScrollElement } from "../scrolling/index";
import {
  measureElementBox,
  type ElementBoxMeasurement,
  type ElementContentBox,
} from "./active-editor/element-content-box";

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
  root?: HTMLElement,
): SceneViewport {
  const measurement = measureElementBox(container);
  return activeSceneViewportFromBounds(
    { ...measurement.contentBox, height: preparedContentHeight(container, root, measurement) },
    readScrollOwnerViewport(scrollOwner),
  );
}

export function activeSceneViewportFromBounds(
  containerBounds: ElementContentBox,
  ownerViewport: SceneRect,
): SceneViewport {
  const containerWidth = Math.max(0, containerBounds.width);
  const containerHeight = Math.max(0, containerBounds.height);
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

function preparedContentHeight(
  container: HTMLElement,
  root: HTMLElement | undefined,
  measurement: ElementBoxMeasurement,
): number {
  if (
    root?.classList.contains("inkbook-active-preparing") === true ||
    root?.classList.contains("inkbook-active-transitioning") === true
  ) {
    const blockSize = container.style.blockSize;
    const target = blockSize.endsWith("px") ? Number.parseFloat(blockSize) : Number.NaN;
    if (Number.isFinite(target) && target > measurement.blockInsets) {
      return Math.max(target - measurement.blockInsets, measurement.contentBox.height);
    }
  }
  return Math.max(0, measurement.contentBox.height);
}

export function readScrollOwnerViewport(scrollOwner: BrowserScrollElement): SceneRect {
  if (scrollOwner.ownerDocument.scrollingElement === scrollOwner) {
    const ownerWindow = scrollOwner.ownerDocument.defaultView;
    const clientWidth = (scrollOwner as Partial<ScrollOwnerWithClientWidth>).clientWidth;
    const clientHeight = browserScrollMetrics.getClientHeight(scrollOwner);
    const height = positiveOrFallback(clientHeight, ownerWindow?.innerHeight ?? 0);
    const width = positiveOrFallback(clientWidth ?? 0, ownerWindow?.innerWidth ?? 0);
    if (height > 0 && width > 0) {
      return {
        bottom: height,
        left: 0,
        right: width,
        top: 0,
      };
    }
  }
  const bounds = scrollOwner.getBoundingClientRect();
  const clientWidth = (scrollOwner as Partial<ScrollOwnerWithClientWidth>).clientWidth;
  const width = positiveOrFallback(clientWidth ?? 0, bounds.width);
  const height = positiveOrFallback(
    browserScrollMetrics.getClientHeight(scrollOwner),
    bounds.height,
  );
  if (scrollOwner.ownerDocument.scrollingElement === scrollOwner) {
    return {
      bottom: height,
      left: 0,
      right: width,
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
