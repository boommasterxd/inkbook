import { describe, expect, it, vi } from "vitest";

import type { InputPoint } from "../../../../../../src/editor/input/index";
import {
  createBuiltInKeyboardShortcuts,
  type KeyboardShortcutSettingsV1,
} from "../../../../../../src/domain/settings";
import { ActiveEditorKeyboardController } from "../../../../../../src/obsidian/embeds/active-editor/input/controller-keyboard";
import type { ActiveEditorActions } from "../../../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorHistory } from "../../../../../../src/obsidian/embeds/active-editor/history";
import type { ActiveEditorNavigation } from "../../../../../../src/obsidian/embeds/active-editor/navigation/navigation";

function history(): ActiveEditorHistory {
  return new ActiveEditorHistory({
    commitBandOrder: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    removeElements: vi.fn(),
    replaceElements: vi.fn(),
  });
}

function keyboardHarness(
  options: {
    readonly activeElement?: Element | null;
    readonly canPaste?: boolean;
    readonly canClaimPasteShortcut?: boolean;
    readonly canRequestPaste?: boolean;
    readonly hasPasteCandidate?: boolean;
    readonly lastScreenPointer?: InputPoint | null;
    readonly navigationEnabled?: boolean;
    readonly pointerOver?: boolean;
    readonly selectionSize?: number;
    readonly history?: ActiveEditorHistory;
    readonly keyboardShortcuts?: KeyboardShortcutSettingsV1;
  } = {},
) {
  const ownerDocument = {} as Document;
  const execute = vi.fn();
  const updateKeyboardStep = vi.fn(() => false);
  const closeFlyout = vi.fn(() => false);
  const cancelGesture = vi.fn(() => false);
  const isAvailable = vi.fn((action: string) => action === "delete");
  const shortcutPaste = vi.fn();
  const pasteFromClipboardData = vi.fn(() => true);
  const actions = {
    canPaste: options.canPaste ?? false,
    canClaimPasteShortcut:
      options.canClaimPasteShortcut ?? options.canRequestPaste ?? options.canPaste ?? false,
    canRequestPaste: options.canRequestPaste ?? options.canPaste ?? false,
    hasPasteCandidate: options.hasPasteCandidate ?? options.canPaste ?? false,
    execute,
    isAvailable,
    pasteFromClipboardData,
    shortcutPaste,
  } as unknown as ActiveEditorActions;
  const navigation = {
    updateKeyboardStep,
    visibleCenter: vi.fn(() => ({ x: 20, y: 30 })),
  } as unknown as ActiveEditorNavigation;
  const onFeedback = vi.fn();
  const openKeyboardMenu = vi.fn();
  const clearSelection = vi.fn();
  const selectAll = vi.fn();
  const controller = new ActiveEditorKeyboardController({
    activeElement: () => options.activeElement ?? null,
    actions,
    cancelGesture,
    clearSelection,
    closeFlyout,
    history: options.history ?? history(),
    ...(options.keyboardShortcuts === undefined
      ? {}
      : { keyboardShortcuts: options.keyboardShortcuts }),
    lastScreenPointer: () => options.lastScreenPointer ?? null,
    navigation,
    navigationEnabled: () => options.navigationEnabled ?? true,
    ownerDocument,
    onFeedback,
    onPendingChanged: vi.fn(),
    openKeyboardMenu,
    selectAll,
    selectionSize: () => options.selectionSize ?? 0,
  });
  controller.setPointerOver(options.pointerOver ?? true);
  return {
    clearSelection,
    closeFlyout,
    cancelGesture,
    controller,
    execute,
    navigation,
    onFeedback,
    openKeyboardMenu,
    selectAll,
    pasteFromClipboardData,
    isAvailable,
    shortcutPaste,
    updateKeyboardStep,
    ownerDocument,
  };
}

describe("active editor keyboard controller", () => {
  it("zooms a focused canvas without hover using the default viewport anchor", () => {
    const harness = keyboardHarness({ pointerOver: false, lastScreenPointer: { x: 500, y: 300 } });
    harness.updateKeyboardStep.mockReturnValue(true);
    expect(harness.controller.handleKeyDown(key("+", { ctrlKey: true }))).toBe(true);
    expect(harness.updateKeyboardStep).toHaveBeenCalledWith(1, null);
    expect(harness.controller.handleHoverZoom(key("+", { ctrlKey: true }))).toBe(false);
    harness.controller.dispose();
  });
  it("routes navigation, menus, deletion, and selection cancellation without host leakage", () => {
    const lastScreenPointer = { x: 125, y: 275 };
    const harness = keyboardHarness({ lastScreenPointer, selectionSize: 1 });
    harness.updateKeyboardStep.mockReturnValueOnce(true);

    expect(harness.controller.handleKeyDown(key("+", { ctrlKey: true }))).toBe(true);
    expect(harness.updateKeyboardStep).toHaveBeenCalledWith(1, lastScreenPointer);
    expect(harness.controller.handleKeyDown(key("ContextMenu"))).toBe(false);
    expect(harness.controller.handleKeyDown(key("F10", { shiftKey: true }))).toBe(true);
    expect(harness.openKeyboardMenu).toHaveBeenCalledWith({ x: 20, y: 30 });
    expect(harness.controller.handleKeyDown(key("Delete"))).toBe(true);
    expect(harness.execute).toHaveBeenCalledWith("delete");
    expect(harness.controller.handleKeyDown(key("Escape"))).toBe(true);
    expect(harness.clearSelection).toHaveBeenCalledOnce();
  });

  it("applies Escape precedence before allowing the host to handle it", () => {
    const harness = keyboardHarness({ selectionSize: 1 });
    harness.closeFlyout.mockReturnValueOnce(true).mockReturnValue(false);
    harness.cancelGesture.mockReturnValueOnce(true).mockReturnValue(false);

    expect(harness.controller.handleKeyDown(key("Escape"))).toBe(true);
    expect(harness.cancelGesture).not.toHaveBeenCalled();
    expect(harness.controller.handleKeyDown(key("Escape"))).toBe(true);
    expect(harness.clearSelection).not.toHaveBeenCalled();
    expect(harness.controller.handleKeyDown(key("Escape"))).toBe(true);
    expect(harness.clearSelection).toHaveBeenCalledOnce();
  });

  it("claims only available Clipboard shortcuts so the caller preserves native behavior", () => {
    const harness = keyboardHarness({ selectionSize: 1 });
    harness.isAvailable.mockImplementation((action: string) => action === "copy");

    expect(harness.controller.handleKeyDown(key("c", { ctrlKey: true }))).toBe(true);
    expect(harness.execute).toHaveBeenCalledWith("copy");
    expect(harness.controller.handleKeyDown(key("v", { ctrlKey: true }))).toBe(false);
    expect(harness.shortcutPaste).not.toHaveBeenCalled();
    expect(harness.controller.handleKeyDown(key("a"))).toBe(false);
  });

  it("selects every element for Control+A and Command+A", () => {
    const harness = keyboardHarness();

    expect(harness.controller.handleKeyDown(key("a", { ctrlKey: true }))).toBe(true);
    expect(harness.controller.handleKeyDown(key("A", { metaKey: true }))).toBe(true);
    expect(harness.selectAll).toHaveBeenCalledTimes(2);
  });

  it("uses live configurable bindings for canvas and arrange actions", () => {
    const shortcuts = {
      ...createBuiltInKeyboardShortcuts(),
      "bring-forward": { key: "PageUp", modifiers: ["alt"] },
      copy: { key: "k", modifiers: ["mod"] },
    } satisfies KeyboardShortcutSettingsV1;
    const harness = keyboardHarness({ keyboardShortcuts: shortcuts, selectionSize: 1 });
    harness.isAvailable.mockImplementation(
      (action: string) => action === "bring-forward" || action === "copy",
    );

    expect(harness.controller.handleKeyDown(key("c", { ctrlKey: true }))).toBe(false);
    expect(harness.controller.handleKeyDown(key("k", { ctrlKey: true }))).toBe(true);
    expect(harness.controller.handleKeyDown(key("PageUp", { altKey: true }))).toBe(true);
    expect(harness.execute).toHaveBeenNthCalledWith(1, "copy");
    expect(harness.execute).toHaveBeenNthCalledWith(2, "bring-forward");
  });
});

describe("active editor clipboard keyboard controller", () => {
  it("claims Paste through a readable system Clipboard before payload validation", () => {
    const harness = keyboardHarness({ canRequestPaste: true, hasPasteCandidate: false });
    harness.isAvailable.mockReturnValue(true);

    expect(harness.controller.handleKeyDown(key("v", { ctrlKey: true }))).toBe(true);
    expect(harness.shortcutPaste).toHaveBeenCalledOnce();
  });

  it("claims available Cut and Paste shortcuts for Control and Command input", () => {
    const harness = keyboardHarness({ canPaste: true, selectionSize: 1 });
    harness.isAvailable.mockImplementation(
      (action: string) => action === "cut" || action === "paste",
    );

    expect(harness.controller.handleKeyDown(key("x", { metaKey: true }))).toBe(true);
    expect(harness.execute).toHaveBeenCalledWith("cut");
    expect(harness.controller.handleKeyDown(key("v", { ctrlKey: true }))).toBe(true);
    expect(harness.shortcutPaste).toHaveBeenCalledOnce();
    expect(harness.controller.handleKeyDown(key("v", { ctrlKey: true, shiftKey: true }))).toBe(
      false,
    );
  });

  it("keeps direct canvas Clipboard shortcuts owned after Android touch hover ends", () => {
    const harness = keyboardHarness({ canPaste: true, pointerOver: false, selectionSize: 1 });
    harness.isAvailable.mockReturnValue(true);

    expect(harness.controller.handleKeyDown(key("c", { ctrlKey: true }))).toBe(true);
    expect(harness.controller.handleKeyDown(key("v", { metaKey: true }))).toBe(true);
    expect(harness.controller.handleDocumentKeyDown(key("Delete"))).toBe(false);
    expect(harness.execute).toHaveBeenCalledWith("copy");
    expect(harness.shortcutPaste).toHaveBeenCalledOnce();
    expect(harness.updateKeyboardStep).not.toHaveBeenCalled();
  });

  it("claims a repeated Paste shortcut while the first Clipboard operation is pending", () => {
    const harness = keyboardHarness({ canClaimPasteShortcut: true, canRequestPaste: false });

    expect(harness.controller.handleKeyDown(key("v", { ctrlKey: true }))).toBe(true);
    expect(harness.shortcutPaste).toHaveBeenCalledOnce();
  });

  it("claims but does not apply keyboard zoom during a stable geometry gesture", () => {
    const harness = keyboardHarness({ navigationEnabled: false });

    expect(harness.controller.handleKeyDown(key("+", { ctrlKey: true }))).toBe(true);
    expect(harness.updateKeyboardStep).not.toHaveBeenCalled();
  });

  it("leaves text-field shortcuts untouched even while the pointer is over the editor", () => {
    const harness = keyboardHarness({ canPaste: true, selectionSize: 1 });
    harness.isAvailable.mockReturnValue(true);
    const input = {
      getAttribute: () => null,
      nodeType: 1,
      tagName: "INPUT",
    } as unknown as EventTarget;

    expect(harness.controller.handleKeyDown(key("c", { ctrlKey: true, target: input }))).toBe(
      false,
    );
    expect(harness.controller.handleKeyDown(key("+", { ctrlKey: true, target: input }))).toBe(
      false,
    );
    expect(harness.controller.handleDocumentKeyDown(key("Delete", { target: input }))).toBe(false);
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.updateKeyboardStep).not.toHaveBeenCalled();
  });
});

describe("active editor keyboard owner-document boundary", () => {
  it("routes selection shortcuts while the pointer remains over the canvas", () => {
    const harness = keyboardHarness({ canPaste: true, selectionSize: 1 });
    harness.isAvailable.mockReturnValue(true);

    expect(harness.controller.handleDocumentKeyDown(key("c", { ctrlKey: true }))).toBe(true);
    expect(harness.controller.handleDocumentKeyDown(key("Delete"))).toBe(true);
    expect(harness.controller.handleDocumentKeyDown(key("v", { ctrlKey: true }))).toBe(true);
    expect(harness.execute).toHaveBeenCalledWith("copy");
    expect(harness.execute).toHaveBeenCalledWith("delete");
    expect(harness.shortcutPaste).toHaveBeenCalledOnce();
    expect(harness.controller.handleDocumentKeyDown(key("Backspace"))).toBe(false);
  });

  it("rejects hover zoom from a different owning document", () => {
    const harness = keyboardHarness();
    harness.updateKeyboardStep.mockReturnValue(true);
    const foreignView = { document: {} } as Window;

    expect(harness.controller.handleHoverZoom(key("+", { ctrlKey: true, view: foreignView }))).toBe(
      false,
    );
    expect(harness.updateKeyboardStep).not.toHaveBeenCalled();
  });
});

describe("active editor native paste and history keyboard handling", () => {
  it("accepts a native Inkbook paste only inside the pointer boundary and outside editable text", () => {
    const editable = {
      getAttribute: () => "true",
      nodeType: 1,
      parentElement: null,
      tagName: "DIV",
    } as unknown as Element;
    const outside = keyboardHarness({ pointerOver: false });
    const editing = keyboardHarness({ activeElement: editable });
    const available = keyboardHarness();
    const data = { getData: vi.fn(), types: [] };

    expect(outside.controller.handlePaste(data)).toBe(false);
    expect(outside.controller.handlePaste(data, true)).toBe(true);
    expect(editing.controller.handlePaste(data)).toBe(false);
    expect(available.controller.handlePaste(data)).toBe(true);
    expect(outside.pasteFromClipboardData).toHaveBeenCalledOnce();
    expect(editing.pasteFromClipboardData).not.toHaveBeenCalled();
    expect(available.pasteFromClipboardData).toHaveBeenCalledWith(data);
  });

  it("reports the locked-embed requirement instead of consuming absent Canvas history", () => {
    const harness = keyboardHarness();

    expect(harness.controller.handleKeyDown(key("z", { ctrlKey: true }))).toBe(true);
    expect(harness.onFeedback).toHaveBeenCalledWith("history-lock-required");
  });

  it("reports a failed Canvas history transition", async () => {
    const canvasHistory = history();
    const harness = keyboardHarness({ history: canvasHistory });
    canvasHistory.registerApplied({
      payloadBytes: 1,
      redo: async () => true,
      undo: async () => false,
    });

    expect(harness.controller.handleKeyDown(key("z", { ctrlKey: true }))).toBe(true);
    await vi.waitFor(() =>
      expect(harness.onFeedback).toHaveBeenCalledWith("history-change-failed"),
    );
  });
});

function key(value: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: value,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}
