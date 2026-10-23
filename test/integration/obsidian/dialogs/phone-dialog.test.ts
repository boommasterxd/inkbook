// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { Modal, type App, type Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { confirmInkbookAction } from "../../../../src/obsidian/dialogs/action-dialog";
import { InkbookSettingTab } from "../../../../src/obsidian/settings/setting-tab";
import { InkbookSettingsModalController } from "../../../../src/obsidian/settings/settings-modal";
import { dialogButton, installPhoneDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";
import { nativeModalStack, simulateNativeModalBack } from "../../../adapters/obsidian/settings";
import { createTestSettingsStore } from "../../../fixtures/obsidian/settings-store";

installPhoneDialogTestLifecycle();

function app(): App {
  return { workspace: { containerEl: document.body } } as App;
}

function sheet(): HTMLElement {
  const surface = document.querySelector<HTMLElement>(
    ".inkbook-adaptive-panel[data-kind='dialog']",
  );
  if (surface === null) throw new Error("Missing shared phone sheet.");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(surface.getAttribute("aria-modal")).toBe("true");
  expect(surface.querySelector("button[aria-label='Close']")).toBeNull();
  expect(surface.querySelector(".inkbook-adaptive-panel-grabber")).not.toBeNull();
  expect(surface.closest(".inkbook-adaptive-panel-layer")?.getAttribute("data-platform")).toBe(
    "phone",
  );
  return surface;
}

function confirmation(signal?: AbortSignal): Promise<boolean> {
  return confirmInkbookAction(app(), {
    title: "Delete embed?",
    description: "Keep the SVG.",
    confirmLabel: "Delete embed",
    readMotion: () => "full",
    workScheduler: () => workSchedulerFromFrames(window),
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("shared phone dialog sheet", () => {
  it("focuses Cancel after mounting and closes the action sheet after 220 ms", async () => {
    const nativeOpen = vi.spyOn(Modal.prototype, "open");
    const result = confirmation();
    const surface = sheet();
    expect(surface.getAttribute("aria-label")).toBe("Delete embed?");
    expect(surface.hasAttribute("aria-labelledby")).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(dialogButton("Cancel"));
    expect(nativeOpen).toHaveBeenCalledOnce();
    expect(nativeModalStack(document)[0]?.modalEl).toBe(surface);
    dialogButton("Delete embed").click();
    expect(surface.dataset.state).toBe("closing");
    expect(surface.inert).toBe(true);
    await vi.advanceTimersByTimeAsync(219);
    expect(surface.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(true);
    expect(surface.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "pagehide"])(
    "disposes an accepted closing sheet immediately on %s",
    async (cause) => {
      const owner = new AbortController();
      const remove = vi.spyOn(owner.signal, "removeEventListener");
      const result = confirmation(owner.signal);
      const surface = sheet();
      dialogButton("Delete embed").click();
      if (cause === "abort") owner.abort();
      else window.dispatchEvent(new Event("pagehide"));
      await expect(result).resolves.toBe(false);
      expect(surface.isConnected).toBe(false);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["settings", "shortcuts"] as const)(
    "uses the same sheet and focus lifecycle for %s",
    async (view) => {
      const store = createTestSettingsStore();
      store.updateDeviceSettings((settings) => ({ ...settings, motion: "full" }));
      const host = app();
      const tab = new InkbookSettingTab(host, {} as Plugin, store, undefined, undefined, {
        workScheduler: () => workSchedulerFromFrames(window),
      });
      const controller = new InkbookSettingsModalController(host, tab, store);
      controller.open(view);
      const surface = sheet();
      expect(surface.getAttribute("aria-label")).toBe(
        view === "settings" ? "Inkbook settings" : "Keyboard shortcuts",
      );
      expect(surface.hasAttribute("aria-labelledby")).toBe(false);
      vi.advanceTimersToNextFrame();
      expect(surface.contains(document.activeElement)).toBe(true);
      expect(simulateNativeModalBack(document)).toBe(true);
      await vi.advanceTimersByTimeAsync(219);
      expect(surface.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(surface.isConnected).toBe(false);
      controller.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("phone dialog native Back lifecycle", () => {
  it("routes native Back to the current sheet and retains its host until animation finishes", async () => {
    const result = confirmation();
    const surface = sheet();
    expect(simulateNativeModalBack(document)).toBe(true);
    expect(surface.dataset.state).toBe("closing");
    expect(nativeModalStack(document)).toHaveLength(1);
    expect(simulateNativeModalBack(document)).toBe(true);
    await vi.advanceTimersByTimeAsync(219);
    expect(surface.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expectCancelledAndDisposed(result);
  });

  it("preserves the parent native history entry when Back closes a nested confirmation", async () => {
    const parentResult = confirmation();
    const parentSurface = sheet();
    vi.advanceTimersToNextFrame();
    const childResult = confirmation();
    vi.advanceTimersToNextFrame();
    const stack = nativeModalStack(document);
    expect(stack).toHaveLength(2);
    const childSurface = stack[1]?.modalEl;
    simulateNativeModalBack(document);
    simulateNativeModalBack(document);
    expect(parentSurface.dataset.state).toBe("open");
    await vi.advanceTimersByTimeAsync(220);
    await expect(childResult).resolves.toBe(false);
    expect(childSurface?.isConnected).toBe(false);
    expect(nativeModalStack(document)).toHaveLength(1);
    expect(parentSurface.contains(document.activeElement)).toBe(true);
    simulateNativeModalBack(document);
    await vi.advanceTimersByTimeAsync(220);
    await expect(parentResult).resolves.toBe(false);
    expect(nativeModalStack(document)).toHaveLength(0);
  });

  it("removes native history immediately when the owner aborts an exiting sheet", async () => {
    const owner = new AbortController();
    const result = confirmation(owner.signal);
    simulateNativeModalBack(document);
    owner.abort();
    await expectCancelledAndDisposed(result);
  });
});

async function expectCancelledAndDisposed(result: Promise<boolean>): Promise<void> {
  await expect(result).resolves.toBe(false);
  expect(nativeModalStack(document)).toHaveLength(0);
  expect(simulateNativeModalBack(document)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
}

describe("phone settings replacement", () => {
  it("replaces a closing settings sheet without leaving its native history or timer alive", async () => {
    const store = createTestSettingsStore();
    store.updateDeviceSettings((settings) => ({ ...settings, motion: "full" }));
    const host = app();
    const controller = new InkbookSettingsModalController(
      host,
      new InkbookSettingTab(host, {} as Plugin, store, undefined, undefined, {
        workScheduler: () => workSchedulerFromFrames(window),
      }),
      store,
    );
    controller.open("settings");
    const previous = sheet();
    vi.advanceTimersToNextFrame();
    simulateNativeModalBack(document);
    await vi.advanceTimersByTimeAsync(100);
    expect(previous.dataset.state).toBe("closing");
    controller.open("shortcuts");
    const replacement = sheet();
    expect(previous.isConnected).toBe(false);
    expect(replacement).not.toBe(previous);
    expect(replacement.getAttribute("aria-label")).toBe("Keyboard shortcuts");
    expect(nativeModalStack(document)).toHaveLength(1);
    expect(nativeModalStack(document)[0]?.modalEl).toBe(replacement);
    vi.advanceTimersToNextFrame();
    await vi.advanceTimersByTimeAsync(220);
    expect(replacement.isConnected).toBe(true);
    expect(replacement.contains(document.activeElement)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
    expect(nativeModalStack(document)).toHaveLength(0);
    expect(replacement.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("retains saved Full over System Reduced and settles a live saved change while closing", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue(
    Object.assign(new EventTarget(), { matches: true }) as MediaQueryList,
  );
  let preference: "full" | "reduced" = "full";
  let changed: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const result = confirmInkbookAction(app(), {
    title: "Delete embed?",
    description: "Keep the SVG.",
    confirmLabel: "Delete embed",
    readMotion: () => preference,
    observeMotion: (listener) => {
      changed = listener;
      return unsubscribe;
    },
    workScheduler: () => workSchedulerFromFrames(window),
  });
  const surface = sheet();
  dialogButton("Delete embed").click();
  expect(surface.isConnected).toBe(true);
  expect(surface.inert).toBe(true);
  preference = "reduced";
  changed();
  await expect(result).resolves.toBe(true);
  expect(surface.isConnected).toBe(false);
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
