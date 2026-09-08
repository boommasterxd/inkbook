import { vi } from "vitest";

export function immediateFrameScheduler() {
  let handle = 0;
  return {
    cancelAnimationFrame: vi.fn(),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(performance.now());
      return ++handle;
    },
  };
}
