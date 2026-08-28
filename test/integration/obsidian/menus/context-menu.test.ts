// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  openContextMenu,
  populateContextMenu,
  type ContextMenuHandlers,
  type ContextMenuState,
  type MenuFactoryPort,
  type MenuItemPort,
  type MenuPort,
} from "../../../../src/obsidian/menus";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
});

interface RecordedItem {
  readonly calls: string[];
  readonly click: (() => void) | undefined;
  readonly fragment?: DocumentFragment;
}

class FakeItem implements MenuItemPort {
  public readonly calls: string[] = [];
  public click: (() => void) | undefined;
  public fragment: DocumentFragment | undefined;

  public setTitle(title: string): this {
    this.calls.push(`title:${title}`);
    return this;
  }

  public setIcon(icon: string): this {
    this.calls.push(`icon:${icon}`);
    return this;
  }

  public setTitleFragment(fragment: DocumentFragment): this {
    this.fragment = fragment;
    this.calls.push(`title:${fragment.textContent ?? ""}`);
    return this;
  }

  public setDisabled(disabled: boolean): this {
    this.calls.push(`disabled:${disabled}`);
    return this;
  }

  public setWarning(warning: boolean): this {
    this.calls.push(`warning:${warning}`);
    return this;
  }

  public setIsLabel(label: boolean): this {
    this.calls.push(`label:${label}`);
    return this;
  }

  public onClick(callback: (event: unknown) => void): this {
    this.click = () => callback(undefined);
    this.calls.push("click");
    return this;
  }
}

class FakeMenu implements MenuPort {
  public readonly entries: Array<RecordedItem | "separator"> = [];
  public readonly positions: Array<{ position: unknown; document: Document }> = [];
  public hideCallback: (() => void) | undefined;
  public closed = false;

  public addItem(configure: (item: MenuItemPort) => void): this {
    const item = new FakeItem();
    configure(item);
    this.entries.push({
      calls: item.calls,
      click: item.click,
      ...(item.fragment === undefined ? {} : { fragment: item.fragment }),
    });
    return this;
  }

  public addSeparator(): this {
    this.entries.push("separator");
    return this;
  }

  public showAtPosition(position: unknown, ownerDocument: Document): this {
    this.positions.push({ position, document: ownerDocument });
    return this;
  }

  public onHide(callback: () => void): void {
    this.hideCallback = callback;
  }

  public close(): void {
    this.closed = true;
    this.hideCallback?.();
  }
}

function state(overrides: Partial<ContextMenuState> = {}): ContextMenuState {
  return {
    hasSelection: true,
    canPaste: true,
    canBringForward: true,
    canSendBackward: true,
    canBringToFront: true,
    canSendToBack: true,
    ...overrides,
  };
}

function handlers(): ContextMenuHandlers {
  return {
    copy: vi.fn(),
    cut: vi.fn(),
    delete: vi.fn(),
    bringForward: vi.fn(),
    sendBackward: vi.fn(),
    bringToFront: vi.fn(),
    sendToBack: vi.fn(),
    paste: vi.fn(),
    copyEmbed: vi.fn(),
    eraseAll: vi.fn(),
    deleteEmbed: vi.fn(),
  };
}

function titles(menu: FakeMenu): string[] {
  return menu.entries
    .filter((entry): entry is RecordedItem => entry !== "separator")
    .map((entry) => entry.calls.find((call) => call.startsWith("title:"))?.slice(6) ?? "");
}

describe("context menu population", () => {
  it("populates the selection and canvas sections in the contract order", () => {
    const menu = new FakeMenu();
    populateContextMenu(menu, document, state(), handlers());

    expect(titles(menu)).toEqual([
      "Copy",
      "Cut",
      "Paste",
      "Delete",
      "Bring forward",
      "Send backward",
      "Bring to front",
      "Send to back",
      "Copy embed",
      "Erase all",
      "Delete embed",
    ]);
    expect(menu.entries.filter((entry) => entry === "separator")).toHaveLength(4);
    expect(
      menu.entries.every((entry) => entry === "separator" || entry.fragment === undefined),
    ).toBe(true);
    for (const entry of menu.entries) {
      if (entry === "separator" || entry.calls.includes("label:true")) continue;
      expect(entry.calls.some((call) => call.startsWith("icon:"))).toBe(true);
    }
  });

  it("keeps Arrange boundaries visible and disables only unavailable actions", () => {
    const menu = new FakeMenu();
    populateContextMenu(
      menu,
      document,
      state({
        canBringForward: false,
        canSendBackward: false,
        canBringToFront: false,
        canSendToBack: false,
      }),
      handlers(),
    );

    expect(
      menu.entries.some((entry) => entry !== "separator" && entry.calls.includes("label:true")),
    ).toBe(false);
    expect(
      menu.entries
        .filter((entry): entry is RecordedItem => entry !== "separator")
        .filter((entry) => entry.calls.includes("disabled:true"))
        .map((entry) => entry.calls[0]),
    ).toEqual([
      "title:Bring forward",
      "title:Send backward",
      "title:Bring to front",
      "title:Send to back",
    ]);
  });

  it("uses orange caution for clearing and red warning for actual deletion", () => {
    const menu = new FakeMenu();
    populateContextMenu(
      menu,
      document,
      state({ hasSelection: false, canPaste: false }),
      handlers(),
    );

    expect(titles(menu)).toEqual(["Copy embed", "Erase all", "Delete embed"]);
    const erase = menu.entries.find(
      (entry): entry is RecordedItem =>
        entry !== "separator" && entry.calls.includes("title:Erase all"),
    );
    expect(erase?.calls).toContain("icon:inkbook-eraser-caution");
    expect(erase?.calls).not.toContain("warning:true");
    expect(erase?.fragment).toBeUndefined();
    const remove = menu.entries.find(
      (entry): entry is RecordedItem =>
        entry !== "separator" && entry.calls.includes("title:Delete embed"),
    );
    expect(remove?.calls).toContain("warning:true");
  });
});

describe("context menu lifecycle", () => {
  it("does not schedule Inkbook motion or mutate the native menu surface", () => {
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    const menu = new FakeMenu();
    const canvas = createHtmlElement("button");
    const session = openContextMenu(
      { create: () => menu, forEvent: () => menu },
      {
        type: "event",
        ownerDocument: document,
        event: new MouseEvent("contextmenu"),
        canvasInputSurface: canvas,
      },
      state({ hasSelection: false }),
      handlers(),
    );
    const surface = createHtmlElement("div");
    surface.className = "menu";
    document.body.append(surface);

    expect(requestFrame).not.toHaveBeenCalled();
    expect(surface.className).toBe("menu");
    expect(surface.getAttribute("style")).toBeNull();
    session.close("immediate");
    surface.remove();
  });

  it("uses the owning document for positioned menus and returns focus once", () => {
    const menu = new FakeMenu();
    const factory: MenuFactoryPort = {
      create: () => menu,
      forEvent: () => menu,
    };
    const ownerDocument = document;
    const canvas = { ownerDocument, isConnected: true, focus: vi.fn() };
    const control = { ownerDocument, isConnected: true, focus: vi.fn() };
    const session = openContextMenu(
      factory,
      {
        type: "position",
        ownerDocument,
        position: { x: 12, y: 24 },
        returnFocus: control,
        canvasInputSurface: canvas,
      },
      state(),
      handlers(),
    );

    expect(menu.positions).toEqual([{ position: { x: 12, y: 24 }, document: ownerDocument }]);
    session.close();
    session.close();
    expect(control.focus).toHaveBeenCalledTimes(1);
    expect(canvas.focus).not.toHaveBeenCalled();
  });

  it("uses Menu.forEvent for pointer menus and falls back to the canvas when control is detached", () => {
    const menu = new FakeMenu();
    const event = {} as MouseEvent;
    const forEvent = vi.fn(() => menu);
    const create = vi.fn();
    const factory: MenuFactoryPort = {
      create,
      forEvent,
    };
    const ownerDocument = document;
    const canvas = { ownerDocument, isConnected: true, focus: vi.fn() };
    const control = { ownerDocument, isConnected: false, focus: vi.fn() };
    const session = openContextMenu(
      factory,
      { type: "event", ownerDocument, event, returnFocus: control, canvasInputSurface: canvas },
      state({ hasSelection: false }),
      handlers(),
    );

    expect(forEvent).toHaveBeenCalledWith(event);
    expect(create).not.toHaveBeenCalled();
    session.close();
    expect(canvas.focus).toHaveBeenCalledTimes(1);
  });
});
