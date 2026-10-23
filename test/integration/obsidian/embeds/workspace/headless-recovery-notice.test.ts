// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import type { App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  showHeadlessRecoveryNotice,
  type HeadlessRecoveryActions,
} from "../../../../../src/obsidian/embeds/workspace/recovery-notice";
import {
  dialogButton as button,
  installDialogTestLifecycle,
} from "../../../../fixtures/obsidian/dialog";

installDialogTestLifecycle();
afterEach(() => vi.useRealTimers());

function showRecovery(overrides: Partial<HeadlessRecoveryActions> = {}) {
  const actions = {
    reloadExternal: vi.fn(async () => false),
    retry: vi.fn(() => false),
    saveLocalCopy: vi.fn(async () => false),
    ...overrides,
  };
  const app = { workspace: { containerEl: document.body } } as App;
  return { actions, notice: showHeadlessRecoveryNotice(app, actions) };
}

function recoveryButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".inkbook-recovery-actions button")];
}

function dialog(): HTMLElement | null {
  return document.querySelector(".inkbook-action-dialog");
}

describe("native Obsidian headless recovery dialog", () => {
  it("uses the shared modal shell and uses visible text actions and preserves the recovery description", () => {
    showRecovery();

    expect(dialog()?.getAttribute("role")).toBe("dialog");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(dialog()?.getAttribute("aria-label")).toBe("Recover changes");
    expect(dialog()?.textContent).toContain("Your changes are still available in the editor.");
    expect(recoveryButtons().map((element) => element.textContent)).toEqual([
      "Retry",
      "Reload external version",
      "Save copy",
    ]);
    expect(button("Retry").classList.contains("mod-cta")).toBe(true);
    expect(
      dialog()?.querySelector(".inkbook-recovery-actions svg, .inkbook-feedback-icon-button"),
    ).toBeNull();
    expect(button("Retry").autofocus).toBe(true);
    expect(document.activeElement).toBe(button("Retry"));
    expect(document.querySelector(".inkbook-recovery-overlay")).toBeNull();
  });

  it.each([true, false, "throws"] as const)("handles synchronous retry result %s", (result) => {
    vi.useFakeTimers();
    const retry = vi.fn(() => {
      if (result === "throws") throw new Error("save failed");
      return result;
    });
    showRecovery({ retry });
    button("Retry").click();

    expect(retry).toHaveBeenCalledOnce();
    if (result === true) {
      expect(dialog()?.inert).toBe(true);
      vi.advanceTimersByTime(119);
      expect(dialog()).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(dialog()).toBeNull();
    } else {
      expect(dialog()).not.toBeNull();
      expect(recoveryButtons().every((element) => !element.disabled)).toBe(true);
    }
  });

  it.each(["Reload external version", "Save copy"])(
    "disables actions while %s is pending and closes after confirmation",
    async (label) => {
      let finish: ((confirmed: boolean) => void) | undefined;
      const pending = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const { actions } = showRecovery({ reloadExternal: pending, saveLocalCopy: pending });
      button(label).click();
      expect(recoveryButtons().every((element) => element.disabled)).toBe(true);
      button("Retry").dispatchEvent(new Event("click"));
      expect(actions.retry).not.toHaveBeenCalled();
      button(label).dispatchEvent(new Event("click"));
      expect(pending).toHaveBeenCalledOnce();
      finish?.(true);
      await vi.waitFor(() => expect(dialog()).toBeNull());
    },
  );

  it.each([false, "rejects"])("retains recovery after async result %s", async (result) => {
    showRecovery({
      saveLocalCopy: async () => {
        if (result === "rejects") throw new Error("write failed");
        return false;
      },
    });
    button("Save copy").click();
    await vi.waitFor(() =>
      expect(recoveryButtons().every((element) => !element.disabled)).toBe(true),
    );
    expect(dialog()).not.toBeNull();
  });
});

describe("headless recovery dialog lifecycle", () => {
  it.each(["Escape", "Close", "pagehide", "owner"])(
    "dismisses via %s without resolving recovery and removes action listeners",
    (method) => {
      const { actions, notice } = showRecovery();
      const stale = recoveryButtons();
      if (method === "Escape")
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else if (method === "Close") button("Close").click();
      else if (method === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else notice.close();
      for (const element of stale) element.click();
      notice.close();

      expect(dialog()).toBeNull();
      expect(actions.retry).not.toHaveBeenCalled();
      expect(actions.reloadExternal).not.toHaveBeenCalled();
      expect(actions.saveLocalCopy).not.toHaveBeenCalled();
    },
  );

  it.each([true, false, "rejects"] as const)(
    "ignores async completion %s after closing",
    async (result) => {
      let finish: ((confirmed: boolean) => void) | undefined;
      let fail: (() => void) | undefined;
      const { notice } = showRecovery({
        saveLocalCopy: () =>
          new Promise<boolean>((resolve, reject) => {
            finish = resolve;
            fail = () => reject(new Error("closed"));
          }),
      });
      button("Save copy").click();
      notice.close();
      if (result === "rejects") fail?.();
      else finish?.(result);
      await Promise.resolve();
      expect(dialog()).toBeNull();
    },
  );
});
