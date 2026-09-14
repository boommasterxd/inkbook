// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { AdaptivePanelSession } from "../../../../src/obsidian/menus/adaptive-panel";
import { installPhoneDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";

installPhoneDialogTestLifecycle();

function setup(kind: "dialog" | "style" | "background", durationMs = 220) {
  const onClosed = vi.fn();
  const session = new AdaptivePanelSession({
    anchor: document.body,
    canvasInputSurface: document.body,
    createContent: () => window.createFragment(),
    durationMs,
    kind,
    label: kind,
    onClosed,
    ownerDocument: document,
    ownerWindow: window,
    renderIcon: vi.fn(),
  });
  const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel")!;
  const backdrop = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-backdrop")!;
  return { session, surface, backdrop, onClosed };
}

describe.each(["dialog", "style", "background"] as const)("%s entry interruption", (kind) => {
  it.each(["75px", "25%"])("starts exit from the visible %s entry position", (position) => {
    const fixture = setup(kind);
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(50);
    const originalComputedStyle = window.getComputedStyle.bind(window);
    const computed = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element !== fixture.surface && element !== fixture.backdrop)
        return originalComputedStyle(element);
      // Entry must still be active when its rendered position is sampled.
      expect(fixture.surface.dataset.presence).toBe("entering");
      return { translate: `0px ${position}`, opacity: "1" } as CSSStyleDeclaration;
    });

    fixture.session.close();

    expect(computed).toHaveBeenCalledWith(fixture.surface);
    expect(fixture.surface.style.getPropertyValue("--inkbook-adaptive-panel-drag")).toBe(position);
    expect(fixture.surface.dataset.presence).toBeUndefined();
    expect(fixture.surface.dataset.state).toBe("closing");
    expect(fixture.surface.isConnected).toBe(true);
    expect(fixture.onClosed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(220);
    expect(fixture.surface.isConnected).toBe(false);
    expect(fixture.onClosed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { durationMs: 220, mode: "immediate" as const },
    { durationMs: 0, mode: "animated" as const },
  ])("cleans up immediately for $durationMs ms / $mode", ({ durationMs, mode }) => {
    const fixture = setup(kind, durationMs);
    fixture.session.close(mode);
    expect(fixture.surface.isConnected).toBe(false);
    expect(fixture.onClosed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
