// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { type App, Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LockedEmbedMenu } from "../../../../src/obsidian/embeds/presentation/locked-embed-menu";
import { createOwnedMenuFactory } from "../../../../src/obsidian/menus/owned-menu-factory";
import { createPhoneSheetHost } from "../../../../src/obsidian/menus/panels/phone-sheet-host";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
import { createLockedEmbedPreview } from "../../../fixtures/obsidian/locked-embed-preview";

const controllers: LockedEmbedMenu[] = [];

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
  Platform.isMobile = false;
  Platform.isPhone = false;
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function harness() {
  const { root, preview } = createLockedEmbedPreview(document);
  const onEdit = vi.fn();
  const onOpenSvg = vi.fn();
  const onDeleteEmbed = vi.fn();
  const app = { workspace: { containerEl: document.body } } as App;
  const controller = new LockedEmbedMenu({
    root,
    preview,
    factory: createOwnedMenuFactory({
      anchor: preview,
      workScheduler: workSchedulerFromFrames(window),
      createPhoneSheetHost: () => createPhoneSheetHost(app),
    }),
    onEdit,
    onOpenSvg,
    onDeleteEmbed,
  });
  controllers.push(controller);
  preview.addEventListener("click", onEdit);
  return { root, preview, controller, onEdit, onOpenSvg, onDeleteEmbed };
}

function contextMenu(target: HTMLElement): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 50,
  });
  target.dispatchEvent(event);
  return event;
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function pointer(target: EventTarget, type: string, options: Partial<PointerEventInit> = {}) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    clientX: 40,
    clientY: 50,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function releaseTouch(target: HTMLElement): void {
  pointer(target, "pointerup");
  target.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
}

function tap(target: HTMLElement): void {
  pointer(target, "pointerdown");
  releaseTouch(target);
}

function expectConsumedTouchRelease(test: ReturnType<typeof harness>): void {
  releaseTouch(test.preview);
  expect(test.onEdit).not.toHaveBeenCalled();
  expect(test.root.dataset.inkbookState).toBe("locked");
}

describe("locked embed context actions", () => {
  it.each(["desktop", "tablet", "phone"])("opens without activation on %s", (mode) => {
    Platform.isMobile = mode !== "desktop";
    Platform.isPhone = mode === "phone";
    const test = harness();
    const event = contextMenu(test.preview);
    expect(event.defaultPrevented).toBe(true);
    expect(menuItems().map((item) => item.textContent)).toEqual([
      "Edit embed",
      "Open SVG file",
      "Delete embed",
    ]);
    expect(test.onEdit).not.toHaveBeenCalled();
    expect(test.root.dataset.inkbookState).toBe("locked");
    menuItems()[0]!.click();
    expect(test.onEdit).toHaveBeenCalledOnce();
    expect(menuItems()).toHaveLength(0);
  });

  it.each([
    ["desktop", "Open SVG file"],
    ["desktop", "Delete embed"],
    ["tablet", "Open SVG file"],
    ["tablet", "Delete embed"],
    ["phone", "Open SVG file"],
    ["phone", "Delete embed"],
  ])("hands off on %s before %s", (mode, title) => {
    Platform.isMobile = mode !== "desktop";
    Platform.isPhone = mode === "phone";
    const test = harness();
    const callback = title === "Open SVG file" ? test.onOpenSvg : test.onDeleteEmbed;
    const target = document.body.createEl("button");
    callback.mockImplementation(() => {
      expect(menuItems()).toHaveLength(0);
      expect(document.activeElement).toBe(test.preview);
      target.focus();
    });
    contextMenu(test.preview);
    menuItems()
      .find((item) => item.textContent === title)!
      .click();
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(target);
    expect(test.onEdit).not.toHaveBeenCalled();
  });

  it.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])(
    "supports keyboard invocation and Escape focus return: $key",
    (invocation) => {
      const test = harness();
      test.preview.focus();
      test.preview.dispatchEvent(new KeyboardEvent("keydown", { ...invocation, bubbles: true }));
      expect(menuItems()).toHaveLength(3);
      const menu = document.querySelector('[role="menu"]');
      contextMenu(test.preview);
      expect(document.querySelector('[role="menu"]')).toBe(menu);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(menuItems()).toHaveLength(0);
      expect(document.activeElement).toBe(test.preview);
      expect(test.onEdit).not.toHaveBeenCalled();
    },
  );

  it("leaves active previews and unrelated embeds host-owned", () => {
    const test = harness();
    test.root.dataset.inkbookState = "active";
    expect(contextMenu(test.preview).defaultPrevented).toBe(false);
    expect(contextMenu(document.body.createEl("img")).defaultPrevented).toBe(false);
    expect(menuItems()).toHaveLength(0);
  });

  it("keeps one menu and releases it on state change or disposal", async () => {
    const test = harness();
    contextMenu(test.preview);
    contextMenu(test.preview);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    test.root.dataset.inkbookState = "unlocking";
    await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    expect(menuItems()).toHaveLength(0);
    test.root.dataset.inkbookState = "locked";
    contextMenu(test.preview);
    test.controller.dispose();
    expect(menuItems()).toHaveLength(0);
    expect(contextMenu(test.preview).defaultPrevented).toBe(false);
  });
});

describe("locked embed touch invocation", () => {
  it("has no idle document gesture listeners and releases temporary listeners on every touch", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const gestureEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel", "scroll"];
    const relevant = (type: string) => gestureEvents.includes(type);
    const test = harness();
    expect(add.mock.calls.filter(([type]) => relevant(type))).toHaveLength(0);
    for (let index = 0; index < 20; index += 1) {
      pointer(test.preview, "pointerdown");
      pointer(document, "pointerup");
    }
    const added = add.mock.calls.filter(([type]) => relevant(type));
    const removed = remove.mock.calls.filter(([type]) => relevant(type));
    expect(added).toHaveLength(100);
    expect(removed).toHaveLength(100);
    expect(removed.map(([type, listener]) => [type, listener])).toEqual(
      expect.arrayContaining(added.map(([type, listener]) => [type, listener])),
    );
    pointer(test.preview, "pointerdown");
    test.controller.dispose();
    expect(remove.mock.calls.filter(([type]) => relevant(type))).toHaveLength(105);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens at the long-press threshold, keeps native scrolling and suppresses its click", () => {
    const test = harness();
    expect(pointer(test.preview, "pointerdown").defaultPrevented).toBe(false);
    vi.advanceTimersByTime(499);
    expect(menuItems()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(menuItems()).toHaveLength(3);
    releaseTouch(test.preview);
    expect(test.onEdit).not.toHaveBeenCalled();
    test.controller.close();
    tap(test.preview);
    expect(test.onEdit).toHaveBeenCalledOnce();
  });

  it.each(["active-preview", "secondary-touch"])("does not arm a hold for %s", (reason) => {
    const test = harness();
    if (reason === "active-preview") test.root.dataset.inkbookState = "active";
    pointer(test.preview, "pointerdown", { isPrimary: reason !== "secondary-touch" });
    vi.advanceTimersByTime(500);
    expect(menuItems()).toHaveLength(0);
    expect(test.onEdit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows mouse activation after cancelling an unfinished touch hold", () => {
    const test = harness();
    pointer(test.preview, "pointerdown");
    pointer(test.preview, "pointerdown", { pointerId: 2, pointerType: "mouse" });
    vi.advanceTimersByTime(500);
    expect(menuItems()).toHaveLength(0);
    pointer(test.preview, "pointerup", { pointerId: 2, pointerType: "mouse" });
    test.preview.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(test.onEdit).toHaveBeenCalledOnce();
  });

  it.each(["movement", "second-touch", "cancel", "scroll", "blur", "dispose"])(
    "cancels pending long press on %s",
    (reason) => {
      const test = harness();
      pointer(test.preview, "pointerdown");
      if (reason === "movement") pointer(document, "pointermove", { clientX: 51 });
      if (reason === "second-touch")
        pointer(document, "pointerdown", { pointerId: 2, isPrimary: false });
      if (reason === "cancel") pointer(document, "pointercancel");
      if (reason === "scroll") document.dispatchEvent(new Event("scroll"));
      if (reason === "blur") window.dispatchEvent(new Event("blur"));
      if (reason === "dispose") test.controller.dispose();
      vi.advanceTimersByTime(500);
      expect(menuItems()).toHaveLength(0);
      expect(test.onEdit).not.toHaveBeenCalled();
    },
  );

  it("consumes native touch compatibility menus without replacing the owned menu", () => {
    const test = harness();
    pointer(test.preview, "pointerdown");
    vi.advanceTimersByTime(500);
    const menu = document.querySelector('[role="menu"]');
    const event = new PointerEvent("contextmenu", {
      pointerType: "touch",
      bubbles: true,
      cancelable: true,
    });
    test.preview.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBe(menu);
  });
});

describe("locked embed touch dismissal", () => {
  it("consumes a phone backdrop touch released onto the preview after the sheet closes", () => {
    Platform.isMobile = true;
    Platform.isPhone = true;
    const test = harness();
    test.root.dataset.inkbookMotion = "full";
    test.preview.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));
    const backdrop = document.querySelector<HTMLElement>(".inkbook-adaptive-panel-backdrop");
    expect(backdrop).not.toBeNull();
    pointer(backdrop!, "pointerdown");
    vi.advanceTimersByTime(1_000);
    expect(menuItems()).toHaveLength(0);
    expect(backdrop!.isConnected).toBe(false);

    expectConsumedTouchRelease(test);
    tap(test.preview);
    expect(test.onEdit).toHaveBeenCalledOnce();
  });

  it.each(["keyboard", "long-press"])(
    "consumes a preview tap that dismisses the %s menu even after its exit finishes",
    (invocation) => {
      Platform.isMobile = true;
      const test = harness();
      test.root.dataset.inkbookMotion = "full";
      if (invocation === "keyboard") {
        test.preview.focus();
        test.preview.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }),
        );
      } else {
        pointer(test.preview, "pointerdown");
        vi.advanceTimersByTime(500);
        releaseTouch(test.preview);
      }
      expect(menuItems()).toHaveLength(3);
      expect(test.onEdit).not.toHaveBeenCalled();

      pointer(test.preview, "pointerdown");
      vi.advanceTimersByTime(1_000);
      expect(menuItems()).toHaveLength(0);
      expectConsumedTouchRelease(test);
      tap(test.preview);
      expect(test.onEdit).toHaveBeenCalledOnce();
    },
  );

  it("releases document dismissal listeners after closing and disposing an open menu", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const test = harness();
    const pointerDownCalls = (calls: typeof add.mock.calls) =>
      calls.filter(([type]) => type === "pointerdown");
    expect(pointerDownCalls(add.mock.calls)).toHaveLength(0);
    contextMenu(test.preview);
    test.controller.close();
    const closedCalls = pointerDownCalls(add.mock.calls);
    expect(closedCalls.length).toBeGreaterThan(0);
    expect(pointerDownCalls(remove.mock.calls)).toHaveLength(closedCalls.length);
    expect(pointerDownCalls(remove.mock.calls)).toEqual(expect.arrayContaining(closedCalls));

    contextMenu(test.preview);
    test.controller.dispose();

    const added = pointerDownCalls(add.mock.calls);
    expect(pointerDownCalls(remove.mock.calls)).toHaveLength(added.length);
    expect(pointerDownCalls(remove.mock.calls)).toEqual(expect.arrayContaining(added));
    expect(menuItems()).toHaveLength(0);
  });
});
