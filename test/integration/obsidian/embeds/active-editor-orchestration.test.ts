import { activeActions } from "../../../fixtures/obsidian/editor-actions";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { createLargeClipboardCandidate } from "../../../fixtures/persistence/clipboard-candidate";
import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import type { ClipboardCandidates, PastePlan } from "../../../../src/persistence/clipboard/public";
import { INKBOOK_CLIPBOARD_WEB_MIME } from "../../../../src/persistence/clipboard/constants";
import { ActiveEditorActions } from "../../../../src/obsidian/embeds/active-editor/controller-actions";
import type { ActiveEditorMenuController } from "../../../../src/obsidian/embeds/active-editor/controller-menu";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import type { MenuFactoryPort, MenuItemPort, MenuPort } from "../../../../src/obsidian/menus/index";
import { createActiveEditorMenuController } from "../../../fixtures/obsidian/active-editor-menu-controller";
import { createClipboardModelDefaults } from "./active-editor-clipboard-fixtures";

describe("active editor Clipboard discovery", () => {
  it("exposes a toolbar candidate without planning and defers the full plan until Paste", async () => {
    const candidate = createLargeClipboardCandidate();
    const { actions, planClipboardPaste, stateChanged } = clipboardDiscovery(
      clipboardWindowWithRead(candidate),
    );

    expect(actions.canPaste).toBe(false);
    await expect(actions.refreshPasteAvailability()).resolves.toBe(true);
    expect(actions.canPaste).toBe(true);
    expect(stateChanged).toHaveBeenCalledOnce();
    expect(planClipboardPaste).not.toHaveBeenCalled();
    actions.execute("paste");
    await vi.waitFor(() => expect(planClipboardPaste).toHaveBeenCalledOnce());
    expect(planClipboardPaste).toHaveBeenCalledWith(
      expect.objectContaining({ customText: candidate }),
      { kind: "toolbar", visibleCanvasCenter: { x: 100, y: 100 } },
      undefined,
    );

    expect(contextMenuTitles(actions)).toContain("Paste");
    actions.dispose();
  });

  it("ignores Inkbook data after a non-Inkbook first Clipboard item", async () => {
    const firstText = vi.fn(async () => "ordinary text");
    const secondText = vi.fn(async () => "INKBOOK/1:{}");
    const planClipboardPaste = vi.fn(async (candidates: ClipboardCandidates) =>
      candidates.customText === undefined ? null : pastePlan(),
    );
    const model = documentModel(planClipboardPaste);
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindow(async () => [
        clipboardItem("text/plain", firstText),
        clipboardItem(INKBOOK_CLIPBOARD_WEB_MIME, secondText),
      ]),
      vi.fn(),
    );

    await expect(actions.refreshPasteAvailability()).resolves.toBe(false);
    expect(actions.canPaste).toBe(false);
    expect(firstText).toHaveBeenCalledOnce();
    expect(secondText).not.toHaveBeenCalled();
    actions.dispose();
  });

  it("keeps context-menu Paste retryable without exposing the toolbar button after a failed probe", async () => {
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
    expect(actions.canRequestPaste).toBe(true);
    expect(planClipboardPaste).not.toHaveBeenCalled();

    expect(contextMenuTitles(actions)).toContain("Paste");
    actions.dispose();
  });

  it("ignores a Clipboard probe that finishes after the editor is disposed", async () => {
    let completeRead: ((items: ClipboardItem[]) => void) | undefined;
    const read = new Promise<ClipboardItem[]>((resolve) => {
      completeRead = resolve;
    });
    const { actions, planClipboardPaste, stateChanged } = clipboardDiscovery(
      clipboardWindow(() => read),
    );

    const probe = actions.refreshPasteAvailability();
    actions.dispose();
    completeRead?.([]);

    await expect(probe).resolves.toBe(false);
    expect(planClipboardPaste).not.toHaveBeenCalled();
    expect(stateChanged).not.toHaveBeenCalled();
  });
});

describe("active editor Clipboard action feedback", () => {
  it("reports the same invalid Clipboard feedback for shortcut, context-menu, and native Paste", async () => {
    const model = documentModel(vi.fn(async () => null));
    const onFeedback = vi.fn();
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindowWithRead("ordinary text", "text/plain"),
      vi.fn(),
      new Set(),
      onFeedback,
    );

    actions.shortcutPaste();
    await vi.waitFor(() => {
      expect(onFeedback).toHaveBeenCalledTimes(1);
      expect(actions.canRequestPaste).toBe(true);
    });
    actions.execute("paste", {
      invocationPoint: { x: 20, y: 30 },
      kind: "context-menu",
    });
    await vi.waitFor(() => {
      expect(onFeedback).toHaveBeenCalledTimes(2);
      expect(actions.canRequestPaste).toBe(true);
    });
    expect(
      actions.pasteFromClipboardData({
        getData: () => "ordinary text",
        types: ["text/plain"],
      }),
    ).toBe(true);

    expect(onFeedback).toHaveBeenCalledTimes(3);
    expect(onFeedback.mock.calls).toEqual([
      ["clipboard-paste-invalid"],
      ["clipboard-paste-invalid"],
      ["clipboard-paste-invalid"],
    ]);
    actions.dispose();
  });

  it("reports invalid Clipboard feedback when a previously visible toolbar Paste becomes stale", async () => {
    let readCount = 0;
    const model = documentModel(
      vi.fn(async (candidates: ClipboardCandidates) =>
        candidates.customText === undefined ? null : pastePlan(),
      ),
    );
    const onFeedback = vi.fn();
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindow(async () => {
        readCount += 1;
        return [
          readCount === 1
            ? clipboardItem(INKBOOK_CLIPBOARD_WEB_MIME, async () => "INKBOOK/1:{}")
            : clipboardItem("text/plain", async () => "ordinary text"),
        ];
      }),
      vi.fn(),
      new Set(),
      onFeedback,
    );

    await expect(actions.refreshPasteAvailability()).resolves.toBe(true);
    expect(actions.canPaste).toBe(true);
    actions.execute("paste");

    await vi.waitFor(() => expect(onFeedback).toHaveBeenCalledWith("clipboard-paste-invalid"));
    expect(actions.canPaste).toBe(false);
    actions.dispose();
  });

  it("reports an unexpected Paste pipeline failure without a false success animation", async () => {
    const model = documentModel(
      vi.fn(async () => Promise.reject(new Error("worker paste failed"))),
    );
    const onFeedback = vi.fn();
    const actions = activeActions(
      model,
      new ElementSceneStore(model.store),
      clipboardWindowWithRead("INKBOOK/1:{}"),
      vi.fn(),
      new Set(),
      onFeedback,
    );

    actions.shortcutPaste();

    await vi.waitFor(() => expect(onFeedback).toHaveBeenCalledWith("clipboard-paste-failed"));
    expect(actions.actionConfirmation).toBeNull();
    actions.dispose();
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

it("keeps equivalent replacement selections current and rejects changed deletion selections", async () => {
  const elements = [indexedStroke(0), indexedStroke(1)];
  const original = new Set(elements.map(({ id }) => id));
  let current: ReadonlySet<string> = original;
  const prepareElementMutation = vi.fn<EditableDocumentModel["prepareElementMutation"]>(
    async (_mutation, cancellation) => {
      expect(cancellation?.isCancelled()).toBe(false);
      current = new Set(original);
      expect(cancellation?.isCancelled()).toBe(false);
      const changed = new Set(original);
      changed.delete(elements[0]!.id);
      changed.add("replacement");
      current = changed;
      expect(cancellation?.isCancelled()).toBe(true);
      current = new Set();
      expect(cancellation?.isCancelled()).toBe(true);
      return { status: "noop", token: null };
    },
  );
  const model = {
    ...documentModel(
      vi.fn(async () => null),
      new ElementStore(elements),
    ),
    prepareElementMutation,
  };
  const actions = activeActions(
    model,
    new ElementSceneStore(model.store),
    clipboardWindowWithEmptyRead(),
    vi.fn(),
    () => current,
  );
  actions.execute("delete");
  await vi.waitFor(() => expect(prepareElementMutation).toHaveBeenCalledOnce());
  await prepareElementMutation.mock.results[0]!.value;
  actions.dispose();
});

function clipboardDiscovery(ownerWindow: Window) {
  const planClipboardPaste = vi.fn(async () => pastePlan());
  const model = documentModel(planClipboardPaste);
  const stateChanged = vi.fn();
  const actions = activeActions(
    model,
    new ElementSceneStore(model.store),
    ownerWindow,
    stateChanged,
  );
  return { actions, planClipboardPaste, stateChanged };
}

function menuController(
  actions: ActiveEditorActions,
  menu: RecordedMenu,
  storeSize: number,
): ActiveEditorMenuController {
  const factory: MenuFactoryPort = { create: () => menu, forEvent: () => menu };
  return createActiveEditorMenuController(actions, factory, storeSize);
}

function contextMenuTitles(actions: ActiveEditorActions): readonly string[] {
  const menu = new RecordedMenu();
  const menus = menuController(actions, menu, 0);
  menus.open({ x: 1, y: 2 });
  menus.dispose();
  return menu.titles;
}

function documentModel(
  planClipboardPaste: EditableDocumentModel["planClipboardPaste"],
  store = new ElementStore(),
): EditableDocumentModel {
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
    async prepareElementRemoval(ids, cancellation) {
      const mutation = await store.createRemovalMutationTimeSliced(ids, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => false,
        yieldControl: () => Promise.resolve(),
      });
      if (mutation === "cancelled") return { status: "cancelled", token: null };
      if (mutation === null) return { status: "noop", token: null };
      return this.prepareElementMutation(mutation, cancellation);
    },
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

function clipboardWindowWithRead(text: string, mime: string = INKBOOK_CLIPBOARD_WEB_MIME): Window {
  return clipboardWindow(async () => [clipboardItem(mime, async () => text)]);
}

function clipboardItem(mime: string, text: () => Promise<string>): ClipboardItem {
  return {
    getType: async (requestedMime: string) => {
      if (requestedMime !== mime) throw new TypeError("Unexpected Clipboard MIME type.");
      return new Blob([await text()], { type: mime });
    },
    types: [mime],
  } as unknown as ClipboardItem;
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
