// @vitest-environment happy-dom
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { type App, Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditorToolbarMenuSession } from "../../../../src/obsidian/menus/editor-toolbar-menu";
import { createOwnedMenuFactory } from "../../../../src/obsidian/menus/owned-menu-factory";
import { createPhoneSheetHost } from "../../../../src/obsidian/menus/phone-sheet-host";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createEditorToolbarMenuOptions,
  installNativeMenuMeasurementStyles,
} from "../../../adapters/obsidian/editor-toolbar-menu";
import { nativeModalStack } from "../../../adapters/obsidian/settings";

beforeEach(() => {
  installObsidianDomHelpers();
  installNativeMenuMeasurementStyles();
  vi.useFakeTimers();
});
afterEach(() => {
  document.body.replaceChildren();
  Platform.isMobile = false;
  Platform.isPhone = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  const options = createEditorToolbarMenuOptions();
  options.anchor.className = "inkbook-root";
  options.anchor.dataset.inkbookMotion = "full";
  document.body.append(options.anchor);
  const app = { workspace: { containerEl: document.body } } as App;
  const host = () => createPhoneSheetHost(app);
  const factory = createOwnedMenuFactory({
    anchor: options.anchor,
    workScheduler: workSchedulerFromFrames(window),
    createPhoneSheetHost: host,
  });
  const session = new EditorToolbarMenuSession({ ...options, factory, createPhoneSheetHost: host });
  return { options, session };
}

function clickAction(title: string): void {
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === title,
  );
  if (action === undefined) throw new Error(`Missing action ${title}`);
  action.click();
}

describe.each(["desktop", "tablet", "phone"])("owned toolbar navigation on %s", (mode) => {
  beforeEach(() => {
    Platform.isMobile = mode !== "desktop";
    Platform.isPhone = mode === "phone";
  });

  it("navigates Overflow to Background and back without ending the toolbar session", async () => {
    const { options, session } = fixture();
    clickAction("Background");
    vi.advanceTimersByTime(250);
    await Promise.resolve();
    const back = document.querySelector<HTMLElement>('[aria-label="Back to more options"]');
    expect(back).not.toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(options.onClosed).not.toHaveBeenCalled();
    expect(nativeModalStack(document)).toHaveLength(mode === "phone" ? 1 : 0);
    back?.click();
    await Promise.resolve();
    expect(document.querySelector('[aria-label="Back to more options"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Background");
    expect(options.onClosed).not.toHaveBeenCalled();
    expect(nativeModalStack(document)).toHaveLength(mode === "phone" ? 1 : 0);
    session.close("immediate");
    expect(options.onClosed).toHaveBeenCalledOnce();
    expect(nativeModalStack(document)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["Settings", "Keyboard shortcuts"])(
    "retains the phone host or releases the wide menu for %s",
    async (title) => {
      const { options, session } = fixture();
      const callback =
        title === "Settings" ? options.handlers.onOpenSettings : options.handlers.onOpenShortcuts;
      if (mode === "phone") {
        const surface = document.querySelector(".inkbook-adaptive-panel");
        vi.mocked(callback).mockImplementation((navigation) => {
          expect(navigation).toBeDefined();
          navigation!.push({
            kind: "dialog",
            label: title,
            createContent: () => {
              const fragment = createFragment();
              fragment.append(createEl("input"));
              return fragment;
            },
          });
        });
        clickAction(title);
        vi.advanceTimersByTime(250);
        expect(callback).toHaveBeenCalledOnce();
        expect(document.querySelector(".inkbook-adaptive-panel")).toBe(surface);
        expect(nativeModalStack(document)).toHaveLength(1);
        expect(options.onClosed).not.toHaveBeenCalled();
        session.close("immediate");
        expect(nativeModalStack(document)).toHaveLength(0);
        return;
      }
      vi.mocked(callback).mockImplementation(() => {
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(nativeModalStack(document)).toHaveLength(0);
      });
      clickAction(title);
      expect(callback).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(callback).toHaveBeenCalledOnce();
      expect(options.onClosed).toHaveBeenCalledOnce();
      session.close("immediate");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
