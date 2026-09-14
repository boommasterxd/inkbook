import { vi } from "vitest";

import { createAdaptivePanelFixture } from "../../adapters/obsidian/adaptive-panel";
import { ManualFrameScheduler } from "./manual-frame-scheduler";

export function createPhoneSheetEditableFixture() {
  const frames = new ManualFrameScheduler();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
    frames.requestAnimationFrame(callback),
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) =>
    frames.cancelAnimationFrame(handle),
  );
  const viewport = Object.assign(new EventTarget(), {
    height: 400,
    offsetTop: 100,
    offsetLeft: 0,
    width: 360,
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const input = window.createEl("input");
  const fixture = createAdaptivePanelFixture("style", {
    createContent: () => {
      const fragment = window.createFragment();
      fragment.append(input);
      return fragment;
    },
  });
  frames.runNext(0);
  input.focus();
  const scroll = input.closest<HTMLElement>(".inkbook-adaptive-panel-scroll")!;
  const scrollRead = vi
    .spyOn(scroll, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 300, 360, 200));
  const inputRead = vi
    .spyOn(input, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 530, 100, 30));
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  scroll.scrollTop = 100;
  return { ...fixture, frames, viewport, input, scroll, scrollRead, inputRead };
}

/** Drives the host CSS inset boundary without dispatching viewport events. */
export function installKeyboardInsetObserver() {
  let probe: Element | undefined;
  let notify: (() => void) | undefined;
  const disconnected = vi.fn();
  vi.spyOn(window, "ResizeObserver").mockImplementation(
    class implements ResizeObserver {
      readonly #callback: ResizeObserverCallback;
      #isProbe = false;
      public constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      public observe(target: Element): void {
        if (!target.classList.contains("inkbook-phone-keyboard-inset")) return;
        this.#isProbe = true;
        probe = target;
        notify = () => this.#callback([], this);
      }
      public unobserve(): void {
        /* No observations are delivered automatically. */
      }
      public disconnect(): void {
        if (this.#isProbe) disconnected();
      }
    },
  );
  return {
    disconnected,
    resize(height: number): void {
      if (probe === undefined || notify === undefined)
        throw new Error("No keyboard inset observer.");
      Object.defineProperty(probe, "offsetHeight", { configurable: true, value: height });
      notify();
    },
  };
}
