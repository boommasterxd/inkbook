// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { createAdaptivePanelFixture } from "../../../adapters/obsidian/adaptive-panel";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  Platform.isMobile = false;
  Platform.isPhone = false;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
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
