// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { type App, Platform } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  openContextMenu,
  type ContextMenuState,
} from "../../../../src/obsidian/menus/context-menu";
import { createOwnedMenuFactory } from "../../../../src/obsidian/menus/owned-menu-factory";
import { createPhoneSheetHost } from "../../../../src/obsidian/menus/panels/phone-sheet-host";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { createContextMenuHandlers } from "../../../adapters/obsidian/context-menu";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";

beforeEach(() => installObsidianDomHelpers());
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  Platform.isMobile = false;
  Platform.isPhone = false;
  vi.restoreAllMocks();
});

function mount(state: Partial<ContextMenuState> = {}) {
  const canvas = document.body.createEl("button", { cls: "inkbook-root", text: "Drawing" });
  canvas.dataset.inkbookMotion = "reduced";
  const app = { workspace: { containerEl: document.body } } as App;
  const handlers = {
    ...createContextMenuHandlers(),
    lockSelection: vi.fn(),
    unlockSelection: vi.fn(),
    selectLocked: vi.fn(),
  };
  const session = openContextMenu(
    createOwnedMenuFactory({
      anchor: canvas,
      workScheduler: workSchedulerFromFrames(window),
      createPhoneSheetHost: () => createPhoneSheetHost(app),
    }),
    {
      type: "position",
      position: { x: 20, y: 30 },
      ownerDocument: document,
      canvasInputSurface: canvas,
    },
    {
      hasSelection: true,
      canPaste: false,
      canBringForward: false,
      canSendBackward: false,
      canBringToFront: false,
      canSendToBack: false,
      selectionLock: "lock",
      canSelectLocked: true,
      ...state,
    },
    handlers,
  );
  return { session, handlers, canvas };
}

function item(name: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === name,
  );
  if (element === undefined) throw new Error(`Missing menu item: ${name}`);
  return element;
}

it.each(["desktop", "tablet", "phone"])(
  "exposes named lock actions with keyboard access on %s",
  async (mode) => {
    Platform.isMobile = mode !== "desktop";
    Platform.isPhone = mode === "phone";
    const owner = mount();
    try {
      const lock = item("Lock selection");
      const surface = lock.closest<HTMLElement>('[role="menu"], [role="dialog"]')!;
      await assertAccessibleSemantics(surface, ["aria-command-name", "aria-valid-attr-value"]);
      lock.focus();
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(owner.handlers.lockSelection).toHaveBeenCalledOnce();
      expect(owner.handlers.unlockSelection).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(owner.canvas);
    } finally {
      owner.session.close("immediate");
    }
  },
);

it("offers Unlock for a fully locked selection and disables destructive actions", () => {
  const owner = mount({ selectionLock: "unlock", canCut: false, canDelete: false });
  try {
    expect(item("Cut").getAttribute("aria-disabled")).toBe("true");
    expect(item("Delete").getAttribute("aria-disabled")).toBe("true");
    item("Cut").click();
    expect(owner.handlers.cut).not.toHaveBeenCalled();
    item("Unlock selection").click();
    expect(owner.handlers.unlockSelection).toHaveBeenCalledOnce();
  } finally {
    owner.session.close("immediate");
  }
});

it("can select all locked elements from the empty canvas context menu", () => {
  const owner = mount({ hasSelection: false, selectionLock: "none" });
  try {
    expect(document.body.textContent).not.toContain("Lock selection");
    item("Select all locked elements").click();
    expect(owner.handlers.selectLocked).toHaveBeenCalledOnce();
  } finally {
    owner.session.close("immediate");
  }
});
