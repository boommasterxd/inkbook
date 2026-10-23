// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { createAdaptivePanelFixture } from "../../../../adapters/obsidian/adaptive-panel";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

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

describe("AdaptivePanelSession focus navigation", () => {
  it.each([false, true])("inherits keyboard navigation %s and clears it on touch", (keyboard) => {
    const fixture = createAdaptivePanelFixture("style", { keyboard });
    const layer = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-layer");
    expect(layer?.dataset.inkbookKeyboardNavigation).toBe(String(keyboard));
    fixture.control.dispatchEvent(
      new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }),
    );
    fixture.control.focus();
    expect(layer?.dataset.inkbookKeyboardNavigation).toBe("false");
    fixture.control.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(layer?.dataset.inkbookKeyboardNavigation).toBe("true");
    fixture.session.close("immediate");
  });
});

it("finishes an open exit when the system reduces motion", async () => {
  let reduced = false;
  const listeners = new Set<EventListener>();
  vi.spyOn(window, "matchMedia").mockReturnValue({
    get matches() {
      return reduced;
    },
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
  } as unknown as MediaQueryList);
  const fixture = createAdaptivePanelFixture("style", { motion: "full" });
  fixture.anchor.parentElement!.dataset.inkbookMotion = "system";
  await Promise.resolve();
  const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
  fixture.session.close();
  expect(surface?.isConnected).toBe(true);
  reduced = true;
  for (const listener of [...listeners]) listener(new Event("change"));
  expect(surface?.isConnected).toBe(false);
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

describe.each([false, true])("wide menu entrance, tablet=%s", (tablet) => {
  it("finishes a running exit when the motion preference changes", async () => {
    Platform.isMobile = tablet;
    const fixture = createAdaptivePanelFixture("style", { motion: "full" });
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    fixture.session.close();
    expect(surface?.isConnected).toBe(true);
    fixture.anchor.parentElement!.dataset.inkbookMotion = "reduced";
    await Promise.resolve();
    expect(surface?.isConnected).toBe(false);
    expect(fixture.onClosed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses live duration when motion is enabled after opening", async () => {
    Platform.isMobile = tablet;
    const fixture = createAdaptivePanelFixture("style", { motion: "reduced" });
    const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
    fixture.anchor.parentElement!.dataset.inkbookMotion = "full";
    await Promise.resolve();
    fixture.session.close();
    expect(surface?.isConnected).toBe(true);
    vi.advanceTimersByTime(120);
    expect(surface?.isConnected).toBe(false);
  });

  it.each(["style", "background"] as const)(
    "finishes %s entry after 120ms without replaying on layout updates",
    (kind) => {
      Platform.isMobile = tablet;
      const fixture = createAdaptivePanelFixture(kind, { motion: "full" });
      const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel");
      expect(surface?.style.getPropertyValue("--inkbook-adaptive-panel-entry-duration")).toBe(
        "120ms",
      );
      expect(
        surface
          ?.closest<HTMLElement>(".inkbook-adaptive-panel-layer")
          ?.style.getPropertyValue("--inkbook-adaptive-panel-duration"),
      ).toBe("220ms");
      vi.advanceTimersToNextFrame();
      vi.advanceTimersByTime(103);
      expect(surface?.dataset.presence).toBe("entering");
      vi.advanceTimersByTime(1);
      expect(surface?.dataset.presence).toBeUndefined();
      fixture.session.mutateLayout(() => undefined);
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
    expect(
      surface
        ?.closest<HTMLElement>(".inkbook-adaptive-panel-layer")
        ?.style.getPropertyValue("--inkbook-adaptive-panel-duration"),
    ).toBe("0ms");
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
  for (let index = 0; index < 100; index += 1) fixture.session.mutateLayout(() => undefined);
  expect(frames.mock.calls.length).toBeLessThanOrEqual(1);
  vi.advanceTimersToNextFrame();
  expect(surface.style.insetInlineStart).toBe("222px");
  expect(writes.mock.calls.some(([property]) => property === "block-size")).toBe(false);
  expect(visualSurface).not.toHaveBeenCalled();
  expect(visualScroll).not.toHaveBeenCalled();
  vi.advanceTimersByTime(104);
  expect(surface.dataset.presence).toBeUndefined();
  vi.advanceTimersByTime(116);
  expect(scroll.style.blockSize).toBe("");
  fixture.session.close();
  vi.advanceTimersByTime(120);
  expect(vi.getTimerCount()).toBe(0);
});
