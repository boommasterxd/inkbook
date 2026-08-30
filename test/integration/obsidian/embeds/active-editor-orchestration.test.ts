import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import type { PastePlan } from "../../../../src/persistence/clipboard/public";
import { INKBOOK_CLIPBOARD_WEB_MIME } from "../../../../src/persistence/clipboard/public";
import { ActiveEditorActions } from "../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorMenuController } from "../../../../src/obsidian/embeds/active-editor/controller-menu";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import type { MenuFactoryPort, MenuItemPort, MenuPort } from "../../../../src/obsidian/menus/index";
import { createClipboardModelDefaults } from "./active-editor-clipboard-fixtures";

describe("active editor Clipboard discovery", () => {
  it("validates a fresh system Clipboard before exposing toolbar and context Paste", async () => {
    const planClipboardPaste = vi.fn(async () => pastePlan());
    const model = documentModel(planClipboardPaste);
    const stateChanged = vi.fn();
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindowWithRead("INKBOOK/1:{}"),
      stateChanged,
    );

    expect(actions.canPaste).toBe(false);
    await expect(actions.refreshPasteAvailability()).resolves.toBe(true);
    expect(actions.canPaste).toBe(true);
    expect(stateChanged).toHaveBeenCalledOnce();
    expect(planClipboardPaste).toHaveBeenCalledWith(
      expect.objectContaining({ customText: "INKBOOK/1:{}" }),
      { kind: "toolbar", visibleCanvasCenter: { x: 100, y: 100 } },
    );

    const menu = new RecordedMenu();
    const menus = menuController(actions, menu, 0);
    menus.open({ x: 1, y: 2 });
    expect(menu.titles).toContain("Paste");
    menus.dispose();
    actions.dispose();
  });

  it("keeps Paste safely unavailable when system Clipboard permission fails", async () => {
    const planClipboardPaste = vi.fn(async () => null);
    const model = documentModel(planClipboardPaste);
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindowWithRejectedRead(),
      vi.fn(),
    );

    await expect(actions.refreshPasteAvailability()).resolves.toBe(false);
    expect(actions.canPaste).toBe(false);
    expect(planClipboardPaste).not.toHaveBeenCalled();
    actions.dispose();
  });

  it("ignores a Clipboard probe that finishes after the editor is disposed", async () => {
    let completeRead: ((items: ClipboardItem[]) => void) | undefined;
    const read = new Promise<ClipboardItem[]>((resolve) => {
      completeRead = resolve;
    });
    const planClipboardPaste = vi.fn(async () => pastePlan());
    const model = documentModel(planClipboardPaste);
    const stateChanged = vi.fn();
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindow(() => read),
      stateChanged,
    );

    const probe = actions.refreshPasteAvailability();
    actions.dispose();
    completeRead?.([]);

    await expect(probe).resolves.toBe(false);
    expect(planClipboardPaste).not.toHaveBeenCalled();
    expect(stateChanged).not.toHaveBeenCalled();
  });
});

describe("active editor context-menu scaling", () => {
  it("releases a native menu session as soon as the host hides it", async () => {
    const model = documentModel(vi.fn(async () => null));
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindowWithEmptyRead(),
      vi.fn(),
    );
    const menu = new RecordedMenu();
    const menus = menuController(actions, menu, 0);

    menus.open({ x: 1, y: 2 });
    await vi.waitFor(() => expect(menu.shown).toBe(true));
    menu.hide();
    menus.dispose();

    expect(menu.close).not.toHaveBeenCalled();
    actions.dispose();
  });

  it("materializes each 10k render band only once for one availability pass", async () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => `element-${index}`);
    const materializeBandOrder = vi.fn((band: "content" | "highlight") =>
      band === "content" ? ids : [],
    );
    const sceneStore = { materializeBandOrder } as unknown as ElementSceneStore;
    const model = documentModel(vi.fn(async () => null));
    const actions = activeActions(
      model,
      sceneStore,
      clipboardWindowWithEmptyRead(),
      vi.fn(),
      new Set([ids[5_000]!]),
    );
    const menu = new RecordedMenu();
    const menus = menuController(actions, menu, ids.length);

    menus.open({ x: 1, y: 2 });
    await vi.waitFor(() => expect(menu.shown).toBe(true));
    expect(materializeBandOrder).toHaveBeenCalledTimes(2);
    expect(materializeBandOrder).toHaveBeenNthCalledWith(1, "highlight");
    expect(materializeBandOrder).toHaveBeenNthCalledWith(2, "content");
    menus.dispose();
    actions.dispose();
  });
});

function activeActions(
  model: EditableDocumentModel,
  sceneStore: ElementSceneStore,
  ownerWindow: Window,
  onStateChanged: () => void,
  selection: ReadonlySet<string> = new Set(),
): ActiveEditorActions {
  return new ActiveEditorActions({
    currentSelection: () => selection,
    history: new ActiveEditorHistory(model),
    isAttached: () => true,
    isEnabled: () => true,
    lastSessionPointer: () => null,
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onPasteCommitted: vi.fn(),
    onPendingChanged: vi.fn(),
    onStateChanged,
    ownerWindow,
    sceneStore,
    setSelection: vi.fn(),
    visibleCenter: () => ({ x: 100, y: 100 }),
  });
}

function menuController(
  actions: ActiveEditorActions,
  menu: RecordedMenu,
  storeSize: number,
): ActiveEditorMenuController {
  const factory: MenuFactoryPort = { create: () => menu, forEvent: () => menu };
  return new ActiveEditorMenuController({
    actions,
    factory,
    inputSurface: { focus: vi.fn() } as unknown as HTMLDivElement,
    ownerDocument: {} as Document,
    selectionSize: () => 0,
    storeSize: () => storeSize,
    toScreenPoint: (point) => point,
  });
}

function documentModel(
  planClipboardPaste: EditableDocumentModel["planClipboardPaste"],
): EditableDocumentModel {
  const store = new ElementStore();
  return {
    mutationAvailability: "available",
    arrangeElements: vi.fn(),
    commitBandOrder: (order) => void store.reorderBands(order),
    commitElement: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    commitPreparedElementMutation: vi.fn(() => null),
    ...createClipboardModelDefaults(),
    encodeClipboard: vi.fn(async () => null),
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2_000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    planClipboardPaste,
    prepareElementMutation: vi.fn(async () => ({ status: "noop" as const, token: null })),
    revision: 0,
    store,
  };
}

function pastePlan(): PastePlan {
  return {
    activateTool: "select",
    commandTimestamp: 1,
    contentIds: [],
    elements: [],
    highlightIds: [],
    insertAtBandFront: true,
    repeatState: { fingerprint: "fixture", pasteCount: 1 },
    selectedIds: [],
    translation: { x: 0, y: 0 },
  };
}

function clipboardWindow(read: Clipboard["read"]): Window {
  return {
    navigator: {
      clipboard: {
        read,
        readText: async () => "",
        write: async () => undefined,
        writeText: async () => undefined,
      },
    },
  } as unknown as Window;
}

function clipboardWindowWithRead(customText: string): Window {
  const item = {
    getType: async (mime: string) => new Blob([customText], { type: mime }),
    types: [INKBOOK_CLIPBOARD_WEB_MIME],
  };
  return clipboardWindow(async () => [item as unknown as ClipboardItem]);
}

function clipboardWindowWithRejectedRead(): Window {
  return clipboardWindow(async () => {
    throw new Error("Clipboard read permission denied.");
  });
}

function clipboardWindowWithEmptyRead(): Window {
  return clipboardWindow(async () => []);
}

class RecordedMenu implements MenuPort {
  public readonly titles: string[] = [];
  public shown = false;
  readonly close = vi.fn(() => this.#onHide?.());
  #onHide: (() => void) | undefined;

  public addItem(configure: (item: MenuItemPort) => void): MenuPort {
    configure(chainableItem(this.titles));
    return this;
  }

  public addSeparator(): MenuPort {
    return this;
  }

  public hide(): void {
    this.#onHide?.();
  }

  public onHide(callback: () => void): void {
    this.#onHide = callback;
  }

  public showAtPosition(): MenuPort {
    this.shown = true;
    return this;
  }
}

function chainableItem(titles: string[]): MenuItemPort {
  const item: MenuItemPort = {
    onClick: () => item,
    setDisabled: () => item,
    setIcon: () => item,
    setIsLabel: () => item,
    setTitle: (title) => {
      titles.push(title);
      return item;
    },
    setWarning: () => item,
  };
  return item;
}
