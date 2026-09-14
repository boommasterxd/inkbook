// @vitest-environment happy-dom

import { type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { AdaptivePanelSession } from "../../../../src/obsidian/menus/adaptive-panel";
import { createPhoneSheetHost } from "../../../../src/obsidian/menus/phone-sheet-host";
import { installPhoneDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";
import { nativeModalStack, simulateNativeModalBack } from "../../../adapters/obsidian/settings";

installPhoneDialogTestLifecycle();

describe("phone tool panel native history", () => {
  it.each(["style", "background"] as const)(
    "closes %s through the native Modal Back callback",
    async (kind) => {
      const anchor = document.body.createEl("button");
      const app = { workspace: { containerEl: document.body } } as App;
      const onClosed = vi.fn();
      const session = new AdaptivePanelSession({
        anchor,
        canvasInputSurface: anchor,
        durationMs: 220,
        kind,
        label: kind,
        createPhoneSheetHost: () => createPhoneSheetHost(app),
        ownerDocument: document,
        ownerWindow: window,
        onClosed,
        renderIcon: vi.fn(),
        createContent: () => {
          const fragment = window.createFragment();
          fragment.createEl("button", { text: "Change" });
          return fragment;
        },
      });
      const native = nativeModalStack(document)[0];
      expect(native).toBeDefined();
      expect(native?.modalEl).toBe(document.querySelector(".inkbook-adaptive-panel"));
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      vi.advanceTimersToNextFrame();
      simulateNativeModalBack(document);
      expect(native?.modalEl.dataset.state).toBe("closing");
      expect(onClosed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(220);
      expect(onClosed).toHaveBeenCalledOnce();
      expect(nativeModalStack(document)).toHaveLength(0);
      expect(document.activeElement).toBe(anchor);
      session.close("immediate");
      expect(onClosed).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
