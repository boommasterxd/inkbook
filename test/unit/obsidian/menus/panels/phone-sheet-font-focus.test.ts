// @vitest-environment happy-dom
import { Platform } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBuiltInSettings } from "../../../../../src/domain/settings";
import { createStyleMenuContent } from "../../../../../src/obsidian/menus/style-menu-content";
import { createTextStyleControls } from "../../../../../src/obsidian/menus/text-style-controls";
import type { AdaptivePanelContentLifecycle } from "../../../../../src/obsidian/menus/panels/panel-page";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { createPhoneSheetEditableFixture } from "../../../../fixtures/obsidian/phone-sheet-editable";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";

beforeEach(() => {
  installObsidianDomHelpers();
  Platform.isPhone = true;
  Platform.isMobile = true;
});
afterEach(() => {
  Platform.isPhone = false;
  Platform.isMobile = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "cycles a Settings font popup created before panel=%s and retains Escape ownership",
  (early) => {
    const next = document.createElement("input");
    const cleanups: (() => void)[] = [];
    const createContent = (lifecycle: AdaptivePanelContentLifecycle): DocumentFragment => {
      const fragment = createStyleMenuContent({
        workScheduler: new ManualFrameScheduler(),
        ...lifecycle,
        controls: createTextStyleControls(createBuiltInSettings().toolDefaults.text).filter(
          ({ id }) => id === "text-font-family",
        ),
        ownerDocument: document,
        renderIcon: () => undefined,
        onChange: vi.fn(),
        fontManagementAction: { label: "Manage fonts", onActivate: vi.fn() },
      });
      fragment.append(next);
      return fragment;
    };
    const prepared = early
      ? createContent({
          registerCleanup: (cleanup) => cleanups.push(cleanup),
          mutateLayout: (update) => update(),
        })
      : undefined;
    const f = createPhoneSheetEditableFixture();
    try {
      f.session.navigation!.push({
        kind: "dialog",
        label: "Settings",
        createContent: (lifecycle) => prepared ?? createContent(lifecycle),
      });
      const trigger = f.scroll.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      const key = (value: string, shiftKey = false): void => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
        );
      };
      trigger.focus();
      trigger.click();
      const footer = document.querySelector<HTMLButtonElement>(".inkbook-font-dropdown-manage")!;
      key("Tab");
      expect(document.activeElement).toBe(footer);
      key("Tab", true);
      expect(document.activeElement).toBe(trigger);
      key("Tab");
      key("Tab");
      expect(document.activeElement).toBe(next);
      key("Tab", true);
      expect(document.activeElement).toBe(trigger);
      trigger.click();
      key("Tab");
      key("Escape");
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(next.isConnected).toBe(true);
      key("Escape");
      expect(f.input.isConnected).toBe(true);
    } finally {
      f.session.close("immediate");
      f.restore();
      cleanups.forEach((cleanup) => cleanup());
    }
  },
);
