import { Localization } from "../../../../src/domain/localization";
// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Platform } from "obsidian";
import { Keymap } from "../../../adapters/obsidian/keymap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { installNativeMenuMeasurementStyles } from "../../../adapters/obsidian/editor-toolbar-menu";
import { nativeModalStack } from "../../../adapters/obsidian/settings";
import { createOwnedToolbarMenuFixture as fixture } from "../../../fixtures/obsidian/owned-toolbar-menu";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createTextStyleControls } from "../../../../src/obsidian/menus/text-style-controls";

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

function clickAction(title: string): void {
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === title,
  );
  if (action === undefined) throw new Error(`Missing action ${title}`);
  action.click();
}

function finishHandoff({ options, session }: ReturnType<typeof fixture>): void {
  expect(options.onClosed).toHaveBeenCalledOnce();
  session.close("immediate");
  expect(vi.getTimerCount()).toBe(0);
}

it("dismisses the phone font list before its native sheet and retains a focused field during keyboard resize", () => {
  Platform.isMobile = true;
  Platform.isPhone = true;
  const keymap = new Keymap();
  const releaseCapture = keymap.installCapture(window);
  const { options, session } = fixture({
    initialMenu: "style",
    motion: "reduced",
    keymap,
    state: { styleControls: createTextStyleControls(createBuiltInSettings().toolDefaults.text) },
  });
  const modal = nativeModalStack(document)[0]!;
  modal.scope.register([], "Escape", () => {
    session.close("immediate");
    return false;
  });
  keymap.pushScope(modal.scope);
  try {
    vi.advanceTimersByTime(50);
    const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    trigger.focus();
    trigger.click();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(options.onClosed).not.toHaveBeenCalled();
    const input = document.querySelector<HTMLInputElement>(
      'input[type="number"][aria-label="Font size"]',
    )!;
    input.focus();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(430);
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(500);
    expect(input.isConnected).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(options.onClosed).not.toHaveBeenCalled();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(options.onClosed).toHaveBeenCalledOnce();
  } finally {
    session.close("immediate");
    keymap.popScope(modal.scope);
    releaseCapture();
  }
});

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
        expect(document.activeElement).toBe(options.anchor);
        expect(nativeModalStack(document)).toHaveLength(0);
      });
      clickAction(title);
      expect(callback).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(callback).toHaveBeenCalledOnce();
      finishHandoff({ options, session });
    },
  );

  it.each([
    ["Erase all", "erase-all"],
    ["Delete embed", "delete-embed"],
  ] as const)("hands keyboard focus back before opening %s confirmation", async (title, action) => {
    const { options, session } = fixture();
    const callback = vi.mocked(options.handlers.onOverflowAction);
    callback.mockImplementation(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(nativeModalStack(document)).toHaveLength(0);
      expect(document.activeElement).toBe(options.anchor);
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent === title,
    );
    expect(item).toBeDefined();
    item!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledExactlyOnceWith(action);
    finishHandoff({ options, session });
  });
});

it.each(["desktop", "tablet", "phone"])(
  "closes More options before explicitly opening the quick tour on %s",
  async (mode) => {
    Platform.isMobile = mode !== "desktop";
    Platform.isPhone = mode === "phone";
    const { options, session } = fixture();
    const callback = vi.mocked(options.handlers.onOpenTour!);
    callback.mockImplementation(() => {
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(nativeModalStack(document)).toHaveLength(0);
    });
    clickAction("Quick tour");
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    finishHandoff({ options, session });
  },
);

describe.each(["desktop", "tablet", "phone"])("retained menu locale on %s", (mode) => {
  beforeEach(() => {
    Platform.isMobile = mode !== "desktop";
    Platform.isPhone = mode === "phone";
  });

  it("retains a pending Style value and focus while translating its field and stepper", () => {
    const localization = new Localization("en");
    const { options, session } = fixture({
      localization,
      initialMenu: "style",
      motion: "reduced",
      state: {
        styleControls: [
          {
            id: "table-columns",
            kind: "number",
            label: "Columns",
            value: 3,
            min: 1,
            max: 12,
            step: 1,
          },
        ],
      },
    });
    const input = document.querySelector<HTMLInputElement>('[aria-label="Columns"]')!;
    input.value = "8";
    input.focus();
    localization.setLanguage("de");
    expect(document.querySelector('[aria-label="Spalten"]')).toBe(input);
    expect(input.value).toBe("8");
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[aria-label="Spalten erhöhen"]')).not.toBeNull();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(options.handlers.onStyleChange).toHaveBeenCalledWith("table-columns", 8);
    session.close("immediate");
  });

  it("translates retained menu actions and Background controls without losing navigation or focus", async () => {
    const localization = new Localization("en");
    const { options, session } = fixture({ localization, motion: "reduced" });
    const background = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Background",
    )!;
    background.focus();
    localization.setLanguage("de");
    expect(background.textContent).toBe("Hintergrund");
    expect(document.activeElement).toBe(background);
    expect(background.isConnected).toBe(true);
    expect(options.onClosed).not.toHaveBeenCalled();
    background.click();
    await Promise.resolve();
    vi.advanceTimersByTime(250);
    const choices = [
      ...document.querySelectorAll<HTMLButtonElement>(".inkbook-menu-background-choice"),
    ];
    expect(choices.map((choice) => choice.getAttribute("aria-label"))).toEqual([
      "Keiner",
      "Linien",
      "Punkte",
      "Kästchen",
    ]);
    choices[1]!.focus();
    localization.setLanguage("en");
    expect(choices[1]!.getAttribute("aria-label")).toBe("Lines");
    expect(document.activeElement).toBe(choices[1]);
    const back = document.querySelector<HTMLElement>('[aria-label="Back to more options"]')!;
    expect(back).not.toBeNull();
    back.click();
    await Promise.resolve();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Background");
    expect(options.onClosed).not.toHaveBeenCalled();
    session.close("immediate");
    expect(options.onClosed).toHaveBeenCalledOnce();
  });
});
