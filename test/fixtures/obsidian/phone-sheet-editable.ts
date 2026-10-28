import { vi } from "vitest";
import { MotionGlobalConfig, processFrame } from "motion";

import { createAdaptivePanelFixture } from "../../adapters/obsidian/adaptive-panel";
import { ManualFrameScheduler } from "./manual-frame-scheduler";

export function createPhoneSheetEditableFixture(
  recordCalls = true,
  motion: "full" | "reduced" = "reduced",
) {
  const motionDriver = createEditableMotionDriver(motion);
  const restoreWindow = preserveProperties(window, [
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "visualViewport",
  ]);
  const frames = new ManualFrameScheduler();
  const request: typeof window.requestAnimationFrame = (callback) =>
    frames.requestAnimationFrame(callback);
  const cancel: typeof window.cancelAnimationFrame = (handle) =>
    frames.cancelAnimationFrame(handle);
  if (recordCalls) {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(request);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancel);
  } else {
    window.requestAnimationFrame = request;
    window.cancelAnimationFrame = cancel;
  }
  try {
    const viewport = Object.assign(new EventTarget(), {
      height: 400,
      offsetTop: 100,
      offsetLeft: 0,
      width: 360,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    const input = window.createEl("input");
    const fixture = createAdaptivePanelFixture("style", {
      motion,
      createContent: () => {
        const fragment = window.createFragment();
        fragment.append(input);
        return fragment;
      },
    });
    frames.runNext(0);
    input.focus();
    const scroll = input.closest<HTMLElement>(".inkbook-adaptive-panel-scroll")!;
    const restoreScroll = preserveProperties(scroll, [
      "getBoundingClientRect",
      "scrollHeight",
      "clientHeight",
    ]);
    const restoreInput = preserveProperties(input, ["getBoundingClientRect"]);
    const scrollRect = new DOMRect(0, 300, 360, 200);
    const inputRect = new DOMRect(0, 530, 100, 30);
    let scrollReadCount = 0;
    let inputReadCount = 0;
    const scrollRead = vi.spyOn(scroll, "getBoundingClientRect").mockReturnValue(scrollRect);
    const inputRead = vi.spyOn(input, "getBoundingClientRect").mockReturnValue(inputRect);
    if (!recordCalls) {
      scroll.getBoundingClientRect = () => {
        scrollReadCount += 1;
        return scrollRect;
      };
      input.getBoundingClientRect = () => {
        inputReadCount += 1;
        return inputRect;
      };
    }
    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    scroll.scrollTop = 100;
    return {
      ...fixture,
      frames,
      viewport,
      input,
      scroll,
      scrollRead,
      inputRead,
      advanceMotion: motionDriver.advance,
      get inputReadCount() {
        return recordCalls ? inputRead.mock.calls.length : inputReadCount;
      },
      get scrollReadCount() {
        return recordCalls ? scrollRead.mock.calls.length : scrollReadCount;
      },
      restore: () => {
        restoreInput();
        restoreScroll();
        restoreWindow();
        motionDriver.restore();
      },
    };
  } catch (error) {
    restoreWindow();
    motionDriver.restore();
    throw error;
  }
}

function createEditableMotionDriver(motion: "full" | "reduced") {
  const manualTiming = MotionGlobalConfig.useManualTiming;
  let motionTime = 0;
  if (motion === "full") {
    MotionGlobalConfig.useManualTiming = true;
    processFrame(0);
  }
  return {
    advance: async (duration: number): Promise<void> => {
      const end = motionTime + duration;
      while (motionTime < end) {
        motionTime = Math.min(end, motionTime + 1000 / 120);
        processFrame(motionTime);
        await Promise.resolve();
      }
    },
    restore: (): void => {
      if (manualTiming === undefined) delete MotionGlobalConfig.useManualTiming;
      else MotionGlobalConfig.useManualTiming = manualTiming;
    },
  };
}

function preserveProperties(target: object, keys: readonly string[]): () => void {
  const descriptors = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(target, key)] as const,
  );
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  };
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
