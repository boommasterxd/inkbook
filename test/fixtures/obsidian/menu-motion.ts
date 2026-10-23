import { vi } from "vitest";

/** A clock-controlled WAAPI boundary for menu lifecycle tests in happy-dom. */
vi.mock("../../../src/obsidian/runtime/element-motion", () => ({
  animateOwnedElement: (
    element: HTMLElement,
    keyframes: Record<string, readonly (string | number)[]>,
    options: { duration: number; onComplete?: () => void },
  ) => {
    for (const [name, values] of Object.entries(keyframes)) {
      const value = values[0];
      if (value !== undefined)
        element.style.setProperty(
          name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
          String(value),
        );
    }
    let finishPromise: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finishPromise = resolve;
    });
    let done = false;
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      for (const [name, values] of Object.entries(keyframes)) {
        const value = values[values.length - 1];
        if (value !== undefined)
          element.style.setProperty(
            name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
            String(value),
          );
      }
      options.onComplete?.();
      finishPromise();
    }, options.duration * 1000);
    const cancel = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      finishPromise();
    };
    return { cancel, finished, stop: cancel };
  },
}));
