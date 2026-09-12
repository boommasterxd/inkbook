// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { createAdaptivePanelFixture } from "../../../adapters/obsidian/adaptive-panel";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
  Platform.isMobile = false;
  Platform.isPhone = false;
});

afterEach(() => {
  Platform.isMobile = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each([false, true])("wide menu entrance, tablet=%s", (tablet) => {
  it.each(["style", "background"] as const)(
    "finishes %s entry after 120ms without replaying on layout updates",
    (kind) => {
      Platform.isMobile = tablet;
      const fixture = createAdaptivePanelFixture(kind, { motion: "full" });
      const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
      expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-entry-duration")).toBe(
        "120ms",
      );
      expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-duration")).toBe("220ms");
      vi.advanceTimersToNextFrame();
      vi.advanceTimersByTime(119);
      expect(surface?.dataset.presence).toBe("entering");
      vi.advanceTimersByTime(1);
      expect(surface?.dataset.presence).toBeUndefined();
      fixture.session.requestLayout();
      vi.advanceTimersToNextFrame();
      expect(surface?.dataset.presence).toBeUndefined();
      fixture.session.close();
      expect(surface?.dataset.state).toBe("closing");
      expect(surface?.inert).toBe(true);
      vi.advanceTimersByTime(120);
      expect(surface?.isConnected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not schedule a presence timer under reduced motion", () => {
    Platform.isMobile = tablet;
    const fixture = createAdaptivePanelFixture("style", { motion: "reduced" });
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-entry-duration")).toBe("0ms");
    vi.advanceTimersToNextFrame();
    expect(surface?.dataset.presence).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    fixture.session.close();
  });
});

it("positions and resizes from layout dimensions while entrance is visually scaled", () => {
  const fixture = createAdaptivePanelFixture("background", { motion: "full" });
  const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
  const scroll = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-scroll");
  if (surface === null || scroll === null) throw new Error("Missing adaptive panel.");
  vi.spyOn(surface, "offsetWidth", "get").mockReturnValue(200);
  vi.spyOn(surface, "offsetHeight", "get").mockReturnValue(300);
  const visualSurface = vi
    .spyOn(surface, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 192, 288));
  vi.spyOn(scroll, "offsetHeight", "get").mockReturnValue(100);
  const visualScroll = vi
    .spyOn(scroll, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 192, 96));
  vi.spyOn(scroll, "scrollHeight", "get").mockReturnValue(160);
  vi.advanceTimersToNextFrame();
  const writes = vi.spyOn(scroll.style, "setProperty");
  const frames = vi.spyOn(window, "requestAnimationFrame");
  fixture.session.prepareLayoutChange();
  for (let index = 0; index < 100; index += 1) fixture.session.requestLayout();
  expect(frames).toHaveBeenCalledOnce();
  vi.advanceTimersToNextFrame();
  expect(surface.style.insetInlineStart).toBe("222px");
  expect(writes.mock.calls).toContainEqual(["block-size", "100px"]);
  expect(writes.mock.calls).toContainEqual(["block-size", "160px"]);
  expect(visualSurface).not.toHaveBeenCalled();
  // The sole visual read flushes the start style; its scaled result is not used.
  expect(visualScroll).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(120);
  expect(surface.dataset.presence).toBeUndefined();
  expect(scroll.style.blockSize).toBe("160px");
  vi.advanceTimersByTime(100);
  expect(scroll.style.blockSize).toBe("");
  fixture.session.close();
  vi.advanceTimersByTime(120);
  expect(vi.getTimerCount()).toBe(0);
});
