/** Deterministic frame scheduling and system motion changes for presentation lifecycles. */
export function createPresentationMotionWindow() {
  const frames = new Map<number, FrameRequestCallback>();
  const listeners = new Set<() => void>();
  let nextId = 0;
  let reduced = false;
  const ownerWindow = {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    matchMedia: () => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_type: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_type: string, callback: () => void) => listeners.delete(callback),
    }),
  } as unknown as Window;
  return {
    frames,
    listeners,
    ownerWindow,
    setReduced: (value: boolean) => {
      reduced = value;
      for (const listener of [...listeners]) listener();
    },
    frame: (time: number) => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
  };
}
