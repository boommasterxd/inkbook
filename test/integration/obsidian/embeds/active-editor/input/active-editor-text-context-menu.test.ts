// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { ElementStore } from "../../../../../../src/domain/store/public";
import type { InkElementV1 } from "../../../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../../../src/domain/settings";
import { ActiveTextSession } from "../../../../../../src/obsidian/embeds/active-editor/text-session";
import type { MenuItemPort, MenuPort } from "../../../../../../src/obsidian/menus/menu-ports";
import { installObsidianDomHelpers } from "../../../../../adapters/obsidian/dom";
import {
  createActiveEditorModel,
  createHarness,
} from "../../../../../fixtures/obsidian/active-controller";
import { rectangle, textElement } from "../../../../../unit/domain/schema/fixtures";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["text", "texts", "shape", "mixed", "empty"] as const)(
  "offers editing only for one selected text element: %s",
  (selection) => {
    const text = textElement();
    const shape = rectangle();
    const elements: InkElementV1[] =
      selection === "text"
        ? [text]
        : selection === "texts"
          ? [text, textElement(9)]
          : selection === "shape"
            ? [shape]
            : selection === "mixed"
              ? [text, shape]
              : [];
    const h = createHarness({ model: createActiveEditorModel(new ElementStore(elements)) });
    const items = captureItems(h.menu);
    const edit = vi.spyOn(ActiveTextSession.prototype, "edit").mockResolvedValue(true);
    try {
      h.controller.handleToolbarAction("select");
      h.key("a", { ctrlKey: true });
      for (const copyTextFieldsAsText of [false, true]) {
        items.clear();
        h.controller.updateDrawingPreferences({ ...createBuiltInSettings(), copyTextFieldsAsText });
        h.controller.handleContextMenu(new MouseEvent("contextmenu", { cancelable: true }));
        expect(items.has("Copy text")).toBe(selection === "text" || selection === "texts");
        expect(items.has("Copy text field")).toBe(selection === "text" || selection === "texts");
        expect(items.has("Copy")).toBe(selection === "shape" || selection === "mixed");
      }
      const action = items.get("Edit text");
      expect(action !== undefined).toBe(selection === "text");
      action?.();
      if (selection === "text") expect(edit).toHaveBeenCalledExactlyOnceWith(text.id);
      else expect(edit).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  },
);

it("opens the same text editor from the phone long-press menu without a hardware key", () => {
  const phone = Platform.isPhone;
  Platform.isPhone = true;
  const text = textElement();
  const h = createHarness({ model: createActiveEditorModel(new ElementStore([text])) });
  const items = captureItems(h.menu);
  const edit = vi.spyOn(ActiveTextSession.prototype, "edit").mockResolvedValue(true);
  try {
    h.controller.handleToolbarAction("select");
    const contact = new PointerEvent("pointerdown", {
      pointerType: "touch",
      pointerId: 7,
      isPrimary: true,
      buttons: 1,
      button: 0,
      clientX: 150,
      clientY: 125,
      pressure: 0.5,
    });
    h.controller.handlePointerDown(contact);
    vi.advanceTimersByTime(500);
    expect(h.menu.positions).toHaveLength(1);
    h.controller.handlePointerUp(contact);
    expect(items.has("Edit text")).toBe(true);
    items.get("Edit text")?.();
    expect(edit).toHaveBeenCalledExactlyOnceWith(text.id);
  } finally {
    h.dispose();
    Platform.isPhone = phone;
  }
});

function captureItems(menu: MenuPort): Map<string, () => void> {
  const items = new Map<string, () => void>();
  vi.spyOn(menu, "addItem").mockImplementation((configure) => {
    let title = "";
    const item: MenuItemPort = {
      setTitle: (value) => {
        title = value;
        return item;
      },
      setIcon: () => item,
      setDisabled: () => item,
      setWarning: () => item,
      setIsLabel: () => item,
      onClick: (callback) => {
        items.set(title, () => callback(undefined));
        return item;
      },
    };
    configure(item);
    return menu;
  });
  return items;
}
