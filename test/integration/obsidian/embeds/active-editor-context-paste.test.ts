import { describe, expect, it, vi } from "vitest";

import { ElementStore, type ElementMutation } from "../../../../src/domain/store/public";
import { ActiveEditorActions } from "../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorClipboardController } from "../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { ActiveEditorMenuController } from "../../../../src/obsidian/embeds/active-editor/controller-menu";
import type { MenuFactoryPort, MenuItemPort, MenuPort } from "../../../../src/obsidian/menus/index";
import {
  createClipboardDocumentModel,
  createEncodedClipboardFixture,
  createPastePlan,
  createPreparedToken,
} from "./active-editor-clipboard-fixtures";
import { rectangle } from "../../../unit/domain/store/fixtures";

describe("active editor context paste", () => {
  it("disables repeat offsets for every canvas invocation point", async () => {
    const source = rectangle();
    const encoded = createEncodedClipboardFixture();
    const planClipboardPaste = vi.fn(async () => createPastePlan(source));
    let pendingMutation: ElementMutation | undefined;
    const model = createClipboardDocumentModel({
      store: new ElementStore([source]),
      commitBandOrder: vi.fn(),
      commitPreparedElementMutation: vi.fn(() => appliedMutation()),
      encodeClipboard: vi.fn(async () => encoded),
      planClipboardPaste,
      prepareElementMutation: vi.fn(async (mutation: ElementMutation) => {
        pendingMutation = mutation;
        return { status: "prepared" as const, token: createPreparedToken() };
      }),
      revision: () => 7,
    });
    const controller = new ActiveEditorClipboardController({
      currentSelection: () => new Set([source.id]),
      history: new ActiveEditorHistory(model),
      isPresentationAttached: () => true,
      model,
      onPendingChanged: vi.fn(),
      onResult: vi.fn(),
      onSelectionChanged: vi.fn(),
      ownerWindow: {} as Window,
    });
    const plainText = `Inkbook elements v1:${encoded.customText}`;
    const clipboardData = {
      getData: () => plainText,
      types: ["text/plain"],
    };

    controller.pasteFromClipboardData(clipboardData, {
      kind: "toolbar",
      visibleCanvasCenter: { x: 400, y: 300 },
    });
    await vi.waitFor(() => expect(pendingMutation).toBeDefined());
    pendingMutation = undefined;
    controller.pasteFromClipboardData(clipboardData, {
      kind: "context-menu",
      invocationPoint: { x: 125, y: 225 },
    });
    await vi.waitFor(() => expect(pendingMutation).toBeDefined());
    pendingMutation = undefined;
    controller.pasteFromClipboardData(clipboardData, {
      kind: "context-menu",
      invocationPoint: { x: 700, y: 800 },
    });
    await vi.waitFor(() => expect(pendingMutation).toBeDefined());

    expect(planClipboardPaste.mock.calls[1]?.slice(1)).toEqual([
      { kind: "context-menu", invocationPoint: { x: 125, y: 225 } },
      undefined,
    ]);
    expect(planClipboardPaste.mock.calls[2]?.slice(1)).toEqual([
      { kind: "context-menu", invocationPoint: { x: 700, y: 800 } },
      undefined,
    ]);
    controller.dispose();
  });
});

describe("active editor context Paste menu", () => {
  it("opens synchronously without consuming user activation in a Clipboard probe", () => {
    const refreshPasteAvailability = vi.fn(async () => false);
    const create = vi.fn(() => clickableMenu(new Map()));
    const actions = {
      arrangeAvailability: () => ({
        "bring-forward": false,
        "bring-to-front": false,
        "send-backward": false,
        "send-to-back": false,
      }),
      canPaste: false,
      execute: vi.fn(),
      refreshPasteAvailability,
    } as unknown as ActiveEditorActions;
    const menus = createMenuController(actions, { create, forEvent: create });

    menus.openFromSource("touch", { x: 10, y: 20 });

    expect(create).toHaveBeenCalledOnce();
    expect(refreshPasteAvailability).not.toHaveBeenCalled();
    menus.dispose();
  });

  it("snapshots the page point before a native menu callback runs", () => {
    const execute = vi.fn();
    const callbacks = new Map<string, () => void>();
    const menu = clickableMenu(callbacks);
    const actions = {
      arrangeAvailability: () => ({
        "bring-forward": false,
        "bring-to-front": false,
        "send-backward": false,
        "send-to-back": false,
      }),
      canPaste: true,
      execute,
      refreshPasteAvailability: vi.fn(async () => true),
    } as unknown as ActiveEditorActions;
    const menus = createMenuController(actions, {
      create: () => menu,
      forEvent: () => menu,
    });
    const position = { x: 125, y: 225 };

    menus.openFromSource("touch", position);
    position.x = 900;
    position.y = 950;
    callbacks.get("Paste")?.();

    expect(execute).toHaveBeenCalledWith("paste", {
      kind: "context-menu",
      invocationPoint: { x: 125, y: 225 },
    });
    menus.dispose();
  });
});

function createMenuController(
  actions: ActiveEditorActions,
  factory: MenuFactoryPort,
): ActiveEditorMenuController {
  return new ActiveEditorMenuController({
    actions,
    factory,
    inputSurface: { focus: vi.fn() } as unknown as HTMLDivElement,
    ownerDocument: {} as Document,
    selectionSize: () => 0,
    storeSize: () => 0,
    toScreenPoint: (point) => point,
  });
}

function clickableMenu(callbacks: Map<string, () => void>): MenuPort {
  const port: MenuPort = {
    addItem: (configure) => {
      let title = "";
      const item: MenuItemPort = {
        onClick: (callback) => {
          callbacks.set(title, () => callback(undefined));
          return item;
        },
        setDisabled: () => item,
        setIcon: () => item,
        setIsLabel: () => item,
        setTitle: (value) => {
          title = value;
          return item;
        },
        setWarning: () => item,
      };
      configure(item);
      return port;
    },
    addSeparator: () => port,
    close: vi.fn(),
    onHide: vi.fn(),
    showAtPosition: () => port,
  };
  return port;
}

function appliedMutation(): import("../../../../src/domain/store/public").AppliedElementMutation {
  return {
    forward: { bands: { content: ["paste"], highlight: [] } },
    payloadBytes: 1,
    reverse: { bands: { content: [], highlight: ["paste"] } },
  };
}
