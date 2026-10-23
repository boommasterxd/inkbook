// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Modal, Platform, type App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookMotionModal } from "../../../../src/obsidian/dialogs/inkbook-motion-modal";
import { installDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";

installDialogTestLifecycle();

function setup() {
  const modal = new InkbookMotionModal({ workspace: { containerEl: document.body } } as App);
  return { modal };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  Object.assign(Platform, { isMobile: false, isPhone: false });
  vi.useRealTimers();
});

describe("native modal motion", () => {
  it.each([false, true])(
    "names desktop/tablet dialogs from their own stable title: %s",
    (tablet) => {
      Object.assign(Platform, { isMobile: tablet });
      const first = setup().modal;
      const second = setup().modal;
      first.titleEl.id = "existing-dialog-title";
      first.setTitle("Inkbook settings");
      second.setTitle("Keyboard shortcuts");
      first.open();
      second.open();

      for (const modal of [first, second]) {
        expect(modal.modalEl.getAttribute("role")).toBe("dialog");
        expect(modal.modalEl.getAttribute("aria-modal")).toBe("true");
        expect(document.getElementById(modal.modalEl.getAttribute("aria-labelledby") ?? "")).toBe(
          modal.titleEl,
        );
      }
      expect(first.titleEl.id).toBe("existing-dialog-title");
      expect(first.titleEl.id).not.toBe(second.titleEl.id);
      const titleId = first.titleEl.id;
      first.setTitle("Updated settings");
      expect(document.getElementById(titleId)?.textContent).toBe("Updated settings");
      second.closeImmediately();
      expect(document.getElementById(titleId)).toBe(first.titleEl);
      first.closeImmediately();
      expect(document.getElementById(titleId)).toBeNull();
    },
  );

  it.each([false, true])(
    "animates desktop/tablet and retains the native shell until exit: %s",
    (tablet) => {
      Object.assign(Platform, { isMobile: tablet });
      const { modal } = setup();
      const hostClose = vi.spyOn(Modal.prototype, "close");
      modal.open();
      modal.close();
      expect(modal.modalEl.isConnected).toBe(true);
      expect(modal.modalEl.inert).toBe(true);
      expect(hostClose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(120);
      expect(hostClose).toHaveBeenCalledOnce();
      expect(modal.modalEl.isConnected).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("starts exit from the interrupted entrance and ignores repeated close", () => {
    const { modal } = setup();
    modal.open();
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      scale: "0.97",
      opacity: "0.42",
    } as CSSStyleDeclaration);
    modal.close();
    modal.close();
    expect(modal.modalEl.style.scale).toBe("0.97");
    expect(modal.modalEl.style.opacity).toBe("0.42");
    vi.advanceTimersByTime(119);
    expect(modal.modalEl.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(modal.modalEl.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases entrance animation resources after completion", () => {
    const { modal } = setup();
    modal.open();
    modal.open();
    vi.advanceTimersByTime(120);
    expect(modal.modalEl.isConnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["entering", "closing"])("disposes owned animation on pagehide while %s", (phase) => {
    const { modal } = setup();
    const hostClose = vi.spyOn(Modal.prototype, "close");
    modal.open();
    if (phase === "closing") modal.close();
    window.dispatchEvent(new Event("pagehide"));
    expect(modal.modalEl.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    modal.closeImmediately();
    modal.close();
    expect(hostClose).toHaveBeenCalledOnce();
  });
});

describe("native modal motion preferences", () => {
  it.each(["reduced", "system"] as const)("honors reduced-motion preference %s", (preference) => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const modal = new InkbookMotionModal(
      { workspace: { containerEl: document.body } } as App,
      () => preference,
    );
    modal.open();
    modal.close();
    expect(modal.modalEl.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each([false, true])("settles live saved Reduced while closing %s", (closing) => {
  let preference: "full" | "reduced" = "full";
  let changed: () => void = () => undefined;
  const unsubscribe = vi.fn();
  const modal = new InkbookMotionModal(
    { workspace: { containerEl: document.body } } as App,
    () => preference,
    undefined,
    (listener) => {
      changed = listener;
      return unsubscribe;
    },
  );
  modal.open();
  if (closing) modal.close();
  preference = "reduced";
  changed();
  expect(modal.modalEl.isConnected).toBe(!closing);
  expect(vi.getTimerCount()).toBe(0);
  modal.closeImmediately();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
