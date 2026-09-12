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
