/** Gives the presentation fake cancellable turns; these tests do not assert elapsed delays. */
export function useAsyncWindowFrames(ownerWindow: Window): void {
  const pending = new Set<number>();
  let nextHandle = 0;
  const cancel = (handle: number): void => {
    pending.delete(handle);
  };
  const schedule = (callback: () => void, _delay = 0): number => {
    const handle = ++nextHandle;
    pending.add(handle);
    queueMicrotask(() => {
      if (pending.delete(handle)) callback();
    });
    return handle;
  };
  Object.assign(ownerWindow, {
    cancelAnimationFrame: cancel,
    clearTimeout: cancel,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      schedule(() => callback(ownerWindow.performance.now())),
    setTimeout: schedule,
  });
}
