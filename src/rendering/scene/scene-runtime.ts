import type { SceneCamera, SceneScheduler, SceneViewport } from "./types";

export function browserScheduler(ownerDocument: Document): SceneScheduler {
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) {
    throw new Error("A scene scheduler is required without an owning window.");
  }
  return {
    cancelAnimationFrame: (handle) => ownerWindow.cancelAnimationFrame(handle),
    now: () => ownerWindow.performance.now(),
    requestAnimationFrame: (callback) => ownerWindow.requestAnimationFrame(callback),
  };
}

export function validateCamera(camera: SceneCamera): void {
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.zoom) || camera.zoom <= 0) {
    throw new RangeError("Camera coordinates must be finite and zoom must be positive.");
  }
}

export function validateViewport(viewport: SceneViewport): void {
  if (
    ![viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite) ||
    viewport.width < 0 ||
    viewport.height < 0
  ) {
    throw new RangeError("Viewport coordinates must be finite and dimensions non-negative.");
  }
}

export function sameViewport(left: SceneViewport | undefined, right: SceneViewport): boolean {
  return (
    left !== undefined &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function validateNonNegativeDuration(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Element fade duration must be finite and non-negative.");
  }
}

export function validatePreviewVersion(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${subject} version must be a non-negative safe integer.`);
  }
}

export function validateFrameBudget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("frameBudgetMs must be finite and positive.");
  }
  return value;
}
