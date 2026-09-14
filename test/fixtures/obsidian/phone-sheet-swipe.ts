import { vi } from "vitest";

import { PhoneSheetSwipeController } from "../../../src/obsidian/menus/phone-sheet-swipe";
import { createHtmlElement } from "../../adapters/obsidian/dom";

interface SwipeFrameQueue {
  readonly flush: () => void;
  readonly maxPending: number;
  readonly pending: number;
}

function createSwipeFrameQueue(): SwipeFrameQueue {
  const callbacks = new Map<number, FrameRequestCallback>();
  let handle = 0;
  let maxPending = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    handle += 1;
    callbacks.set(handle, callback);
    maxPending = Math.max(maxPending, callbacks.size);
    return handle;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    callbacks.delete(frame);
  });
  return {
    flush: () => {
      const entry = callbacks.entries().next().value as
        readonly [number, FrameRequestCallback] | undefined;
      if (entry === undefined) throw new Error("No frame is pending.");
      callbacks.delete(entry[0]);
      entry[1](performance.now());
    },
    get maxPending() {
      return maxPending;
    },
    get pending() {
      return callbacks.size;
    },
  };
}

export function createPhoneSheetSwipeHarness(durationMs = 0) {
  const surface = createHtmlElement("section");
  const backdrop = createHtmlElement("div");
  const handle = createHtmlElement("div");
  const scroll = createHtmlElement("div");
  const frames = createSwipeFrameQueue();
  const close = vi.fn();
  let dragWrites = 0;
  let inheritedWrites = 0;

  handle.className = "inkbook-adaptive-panel-drag-region";
  surface.append(handle);
  surface.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
  document.body.append(backdrop, surface);

  const originalSetProperty = surface.style.setProperty.bind(surface.style);
  vi.spyOn(surface.style, "setProperty").mockImplementation((property, value, priority) => {
    if (property === "translate") dragWrites += 1;
    if (property.startsWith("--")) inheritedWrites += 1;
    originalSetProperty(property, value, priority);
  });

  const controller = new PhoneSheetSwipeController({
    backdrop,
    close,
    durationMs,
    ownerWindow: window,
    scroll,
    surface,
  });
  surface.addEventListener("pointerdown", controller.handlePointerDown);
  surface.addEventListener("pointermove", controller.handlePointerMove);
  surface.addEventListener("pointerup", controller.handlePointerUp);
  surface.addEventListener("pointercancel", controller.handlePointerCancel);
  surface.addEventListener("lostpointercapture", controller.handleLostPointerCapture);

  return {
    backdrop,
    close,
    controller,
    frames,
    get dragWrites() {
      return dragWrites;
    },
    get inheritedWrites() {
      return inheritedWrites;
    },
    handle,
    scroll,
    surface,
  };
}

export function touchPointer(
  type: string,
  clientY: number,
  pointerId: number,
  timeStamp: number,
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    clientY,
    pointerId,
    pointerType: "touch",
  });
  Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
  return event;
}
