// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBuiltInSettings } from "../../../../src/domain/settings";
import { createStyleMenuContent } from "../../../../src/obsidian/menus/style-menu-content";
import { createTextStyleControls } from "../../../../src/obsidian/menus/text-style-controls";
import { containsOwnedMenuTarget } from "../../../../src/obsidian/menus/owned-menu-target";
import type { FontChoiceDropdownOptions } from "../../../../src/obsidian/menus/font-choice-dropdown";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";
import * as WideMenuMotion from "../../../../src/obsidian/menus/feedback/wide-menu-motion";

const cleanups: (() => void)[] = [];
beforeEach(installObsidianDomHelpers);
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(
  mixed = false,
  extraOptions = 0,
  mount = document.body,
  fontManagementAction?: FontChoiceDropdownOptions["fontManagementAction"],
) {
  const control = createTextStyleControls(createBuiltInSettings().toolDefaults.text).find(
    ({ id }) => id === "text-font-family",
  )!;
  if (control.kind !== "choice") throw new Error("Missing font choices");
  const onChange = vi.fn();
  const frames = new ManualFrameScheduler();
  const releases: ReturnType<typeof vi.fn<() => void>>[] = [];
  const acquire = vi.fn((_element: HTMLElement, _family: string) => {
    const release = vi.fn<() => void>();
    releases.push(release);
    return release;
  });
  const fragment = createStyleMenuContent({
    workScheduler: frames,
    controls: [
      {
        ...control,
        value: mixed ? null : control.value,
        mixed,
        options: [
          ...control.options,
          ...Array.from({ length: extraOptions }, (_, index) => ({
            value: `custom-${index}`,
            label: `Custom font ${index} with a very long descriptive name`,
          })),
        ],
      },
    ],
    ownerDocument: document,
    onChange,
    renderIcon: () => undefined,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    fontPreviews: { acquire },
    fontManagementAction,
  });
  mount.append(fragment);
  const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
  const popup = list.parentElement!;
  const key = (value: string) =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  trigger.focus();
  const expectManagementHandoff = (): void => {
    expect(fontManagementAction?.onActivate).toHaveBeenCalledExactlyOnceWith(trigger);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.dataset.value).toBe("inter");
    expect(popup.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  };
  return {
    trigger,
    list,
    popup,
    key,
    onChange,
    acquire,
    releases,
    frames,
    expectManagementHandoff,
  };
}

it("navigates mixed font values without committing until Enter and keeps Escape within the dropdown", () => {
  const f = fixture(true, 1);
  const parentEscape = vi.fn();
  document.addEventListener("keydown", parentEscape, true);
  cleanups.push(() => document.removeEventListener("keydown", parentEscape, true));
  expect(f.trigger.getAttribute("aria-label")).toBe("Font family: Mixed");
  expect(f.trigger.hasAttribute("aria-controls")).toBe(false);
  expect(f.list.querySelector('[aria-selected="true"]')).toBeNull();
  f.key("ArrowDown");
  expect(f.list.hidden).toBe(false);
  expect(f.trigger.getAttribute("aria-controls")).toBe(f.list.id);
  expect(f.trigger.getAttribute("aria-activedescendant")).toBe(f.list.children[0]!.id);
  f.key("End");
  expect(f.onChange).not.toHaveBeenCalled();
  f.key("Escape");
  expect(f.list.hidden).toBe(true);
  expect(f.trigger.hasAttribute("aria-controls")).toBe(false);
  expect(f.trigger.hasAttribute("aria-activedescendant")).toBe(false);
  expect(parentEscape).not.toHaveBeenCalled();
  f.key(" ");
  f.key("s");
  f.key("Enter");
  expect(f.onChange).toHaveBeenCalledExactlyOnceWith("text-font-family", "source-serif");
  expect(f.trigger.getAttribute("aria-label")).toBe("Font family: Source Serif 4");
  expect(f.list.querySelector('[data-value="source-serif"]')?.getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(document.activeElement).toBe(f.trigger);
  f.key("Enter");
  f.key("Tab");
  expect(f.list.hidden).toBe(true);
});

it.each([
  { anchorWidth: 65, popupWidth: 65, left: 287 },
  { anchorWidth: 500, popupWidth: 344, left: 8 },
])(
  "matches the trigger width within its viewport, flips and retains modal ownership ($anchorWidth)",
  ({ anchorWidth, popupWidth, left }) => {
    const layer = document.body.createDiv({ cls: "inkbook-adaptive-panel-layer" });
    const panel = layer.createDiv({ cls: "inkbook-adaptive-panel" });
    panel.setAttribute("role", "dialog");
    const f = fixture(false, 64, panel);
    const originalChildren = [...panel.children];
    vi.spyOn(f.trigger, "getBoundingClientRect").mockReturnValue(
      new DOMRect(300, 340, anchorWidth, 44),
    );
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(360);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(430);
    Object.defineProperty(f.popup, "scrollHeight", { configurable: true, get: () => 3000 });
    vi.spyOn(f.popup, "offsetWidth", "get").mockImplementation(
      () => Number.parseFloat(f.popup.style.inlineSize) || 344,
    );
    f.trigger.click();
    expect(f.popup.parentElement).toBe(layer);
    expect([...panel.children]).toEqual(originalChildren);
    expect(panel.querySelector('[role="listbox"]')).toBeNull();
    expect(panel.getAttribute("aria-owns")).toBe(f.popup.id);
    expect(containsOwnedMenuTarget(panel, f.list.children[0]!)).toBe(true);
    expect(f.popup.style.maxInlineSize).toBe("344px");
    expect(f.popup.style.inlineSize).toBe(`${String(popupWidth)}px`);
    expect(f.popup.offsetWidth).toBe(popupWidth);
    expect(f.popup.style.maxBlockSize).toBe("264px");
    expect(f.popup.style.insetInlineStart).toBe(`${String(left)}px`);
    expect(f.popup.style.insetBlockStart).toBe("72px");
    f.list.children[1]!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    expect(f.trigger.getAttribute("aria-expanded")).toBe("true");
    f.key("Escape");
    expect(panel.hasAttribute("aria-owns")).toBe(false);
    expect(panel.querySelector('[role="listbox"]')).toBe(f.list);
    expect(f.list.hidden).toBe(true);
  },
);

it("follows trigger resizing without repeating unchanged placement and disconnects on close", () => {
  let notify: ResizeObserverCallback | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const f = fixture();
  let anchorWidth = 65;
  vi.spyOn(f.trigger, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(300, 100, anchorWidth, 44),
  );
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(360);
  const readWidth = vi
    .spyOn(f.popup, "offsetWidth", "get")
    .mockImplementation(() => Number.parseFloat(f.popup.style.inlineSize) || 100);
  const placement = vi.spyOn(f.popup.style, "setProperty");
  f.trigger.click();
  expect(observe).toHaveBeenCalledTimes(2);
  expect(observe).toHaveBeenCalledWith(f.popup);
  expect(observe).toHaveBeenCalledWith(f.trigger);
  expect(f.popup.style.inlineSize).toBe("65px");
  expect(f.popup.style.insetInlineStart).toBe("287px");
  anchorWidth = 120;
  const initialWrites = placement.mock.calls.length;
  notify!([], {} as ResizeObserver);
  notify!([], {} as ResizeObserver);
  expect(placement).toHaveBeenCalledTimes(initialWrites);
  expect(f.frames.pendingCount).toBe(1);
  f.frames.runNext();
  expect(f.popup.style.inlineSize).toBe("120px");
  expect(f.popup.style.insetInlineStart).toBe("232px");
  const writes = placement.mock.calls.length;
  notify!([], {} as ResizeObserver);
  f.frames.runNext();
  expect(placement).toHaveBeenCalledTimes(writes);
  anchorWidth = 180;
  notify!([], {} as ResizeObserver);
  expect(f.frames.pendingCount).toBe(1);
  f.key("Escape");
  expect(disconnect).toHaveBeenCalledOnce();
  expect(f.frames.pendingCount).toBe(0);
  expect(f.frames.cancelledFrames).toBe(1);
  const reads = readWidth.mock.calls.length;
  notify!([], {} as ResizeObserver);
  expect(f.frames.pendingCount).toBe(0);
  expect(readWidth).toHaveBeenCalledTimes(reads);
  expect(placement).toHaveBeenCalledTimes(writes);
});

it("refreshes final placement after the owning panel entrance changes the trigger geometry", () => {
  let completeEntry: (() => void) | undefined;
  vi.spyOn(WideMenuMotion, "animateWideMenuEntry").mockImplementation(
    (_surface, _duration, onComplete) => {
      completeEntry = onComplete;
      return () => undefined;
    },
  );
  const f = fixture();
  let anchor = new DOMRect(100, 100, 192, 44);
  vi.spyOn(f.trigger, "getBoundingClientRect").mockImplementation(() => anchor);
  vi.spyOn(f.popup, "offsetWidth", "get").mockImplementation(() =>
    Number.parseFloat(f.popup.style.inlineSize),
  );
  f.trigger.click();
  expect(f.popup.style.inlineSize).toBe("192px");
  anchor = new DOMRect(96, 96, 200, 44);
  completeEntry!();
  expect(f.popup.style.inlineSize).toBe("200px");
  expect(f.popup.style.insetInlineStart).toBe("96px");
  f.key("Escape");
  const placement = vi.spyOn(f.popup.style, "setProperty");
  completeEntry!();
  expect(placement).not.toHaveBeenCalled();
});

it("retains the full custom font name and cancels contact released outside without changing the value", () => {
  const f = fixture(false, 1);
  f.trigger.click();
  const custom = f.list.querySelector<HTMLElement>('[data-value="custom-0"]')!;
  expect(custom.getAttribute("aria-label")).toBe(custom.textContent);
  const contact = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  custom.dispatchEvent(contact);
  expect(contact.defaultPrevented).toBe(true);
  document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  expect(f.onChange).not.toHaveBeenCalled();
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(f.list.hidden).toBe(true);
  f.trigger.click();
  custom.click();
  expect(f.trigger.title).toBe(custom.textContent);
  expect(f.trigger.getAttribute("aria-label")).toContain(custom.textContent);
  expect(f.onChange).toHaveBeenCalledExactlyOnceWith("text-font-family", "custom-0");
});

it("leases only intersecting previews, releases offscreen faces and ignores late visibility after disposal", () => {
  let visibility: IntersectionObserverCallback | undefined;
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const f = fixture(false, 64);
  expect(f.acquire).toHaveBeenCalledOnce();
  f.trigger.click();
  expect(observe).toHaveBeenCalledTimes(68);
  const notify = (indices: readonly number[], visible: boolean) =>
    visibility!(
      indices.map((index) => ({
        target: f.list.children[index]!,
        isIntersecting: visible,
      })) as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  notify([0, 1], true);
  expect(f.acquire).toHaveBeenCalledTimes(3);
  expect(f.acquire).toHaveBeenCalledWith(f.list.children[0], "inter");
  const releaseFirst = f.releases[1]!;
  const releaseSecond = f.releases[2]!;
  notify([0], false);
  expect(releaseFirst).toHaveBeenCalledOnce();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  expect(releaseSecond).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  notify([2], true);
  expect(f.acquire).toHaveBeenCalledTimes(3);
  expect(f.releases[0]).toHaveBeenCalledOnce();
});

it("keeps font management separate from selection and reachable by keyboard and touch", () => {
  const onActivate = vi.fn();
  const f = fixture(false, 1, document.body, {
    label: () => "Add/manage fonts",
    onActivate,
  });
  const action = f.popup.querySelector<HTMLButtonElement>("button")!;
  expect(action.getAttribute("aria-label")).toBe("Add/manage fonts");
  expect(action.type).toBe("button");
  expect(f.list.contains(action)).toBe(false);
  f.key("End");
  expect(f.trigger.getAttribute("aria-activedescendant")).toBe(f.list.lastElementChild!.id);
  f.key("Tab");
  expect(document.activeElement).toBe(action);
  expect(f.popup.hidden).toBe(false);
  action.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
  expect(document.activeElement).toBe(f.trigger);
  f.key("Tab");
  action.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(f.popup.hidden).toBe(true);
  expect(document.activeElement).toBe(f.trigger);
  expect(onActivate).not.toHaveBeenCalled();
  f.trigger.click();
  action.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
  expect(f.popup.hidden).toBe(false);
  action.click();
  f.expectManagementHandoff();
});

it("activates focused font management with Enter before the host can suppress its native click", () => {
  const onActivate = vi.fn();
  const f = fixture(false, 0, document.body, { label: "Add/manage fonts", onActivate });
  const hostEnter = vi.fn((event: KeyboardEvent) => event.preventDefault());
  document.addEventListener("keydown", hostEnter);
  cleanups.push(() => document.removeEventListener("keydown", hostEnter));
  f.trigger.click();
  f.key("Tab");
  const action = document.activeElement!;
  expect(action).toBe(f.popup.querySelector("button"));
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  action.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(true);
  expect(hostEnter).not.toHaveBeenCalled();
  f.expectManagementHandoff();
});
