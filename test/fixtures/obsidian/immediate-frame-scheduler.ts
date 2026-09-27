import { vi } from "vitest";

export function immediateFrameScheduler() {
  let handle = 0;
  return {
    cancelFrame: vi.fn(),
    requestFrame: (callback: FrameRequestCallback) => {
      callback(performance.now());
      return ++handle;
    },
  };
}
