import { describe, expect, it, vi } from "vitest";

import type { InputPoint } from "../../../../../src/editor/input/index";
import { ActiveEditorKeyboardController } from "../../../../../src/obsidian/embeds/active-editor/controller-keyboard";
import type { ActiveEditorActions } from "../../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { ActiveEditorNavigation } from "../../../../../src/obsidian/embeds/active-editor/navigation";

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
    readonly lastScreenPointer?: InputPoint | null;
    readonly pointerOver?: boolean;
    readonly selectionSize?: number;
  } = {},
) {
  const ownerDocument = {} as Document;
  const execute = vi.fn();
  const updateKeyboard = vi.fn(() => false);
  const closeFlyout = vi.fn(() => false);
  const cancelGesture = vi.fn(() => false);
  const isAvailable = vi.fn((action: string) => action === "delete");
  const shortcutPaste = vi.fn();
  const pasteFromClipboardData = vi.fn(() => true);
  const actions = {
    canPaste: options.canPaste ?? false,
    execute,
    isAvailable,
    pasteFromClipboardData,
    shortcutPaste,
  } as unknown as ActiveEditorActions;
  const navigation = {
    updateKeyboard,
    visibleCenter: vi.fn(() => ({ x: 20, y: 30 })),
  } as unknown as ActiveEditorNavigation;
  const onNotice = vi.fn();
  const openKeyboardMenu = vi.fn();
  const clearSelection = vi.fn();
  const controller = new ActiveEditorKeyboardController({
    activeElement: () => options.activeElement ?? null,
    actions,
    cancelGesture,
    clearSelection,
    closeFlyout,
    history: history(),
    lastScreenPointer: () => options.lastScreenPointer ?? null,
    navigation,
    ownerDocument,
    onNotice,
    onPendingChanged: vi.fn(),
    openKeyboardMenu,
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
    onNotice,
    openKeyboardMenu,
    pasteFromClipboardData,
    isAvailable,
    shortcutPaste,
    updateKeyboard,
    ownerDocument,
  };
}

describe("active editor keyboard controller", () => {
  it("routes navigation, menus, deletion, and selection cancellation without host leakage", () => {
    const lastScreenPointer = { x: 125, y: 275 };
    const harness = keyboardHarness({ lastScreenPointer, selectionSize: 1 });
    harness.updateKeyboard.mockReturnValueOnce(true);

    expect(harness.controller.handleKeyDown(key("+", { ctrlKey: true }))).toBe(true);
    expect(harness.updateKeyboard).toHaveBeenCalledWith(
      expect.objectContaining({ ctrlKey: true, key: "+" }),
      lastScreenPointer,
    );
    expect(harness.controller.handleKeyDown(key("ContextMenu"))).toBe(true);
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

  it("claims available Cut and Paste shortcuts for Control and Command input", () => {
    const harness = keyboardHarness({ canPaste: true, selectionSize: 1 });
    harness.isAvailable.mockImplementation(
      (action: string) => action === "cut" || action === "paste",
    );

    expect(harness.controller.handleKeyDown(key("x", { metaKey: true }))).toBe(true);
    expect(harness.execute).toHaveBeenCalledWith("cut");
    expect(harness.controller.handleKeyDown(key("v", { ctrlKey: true }))).toBe(true);
    expect(harness.shortcutPaste).toHaveBeenCalledOnce();
  });

  it("requires the pointer boundary for Clipboard and keyboard zoom shortcuts", () => {
    const harness = keyboardHarness({ canPaste: true, pointerOver: false, selectionSize: 1 });
    harness.isAvailable.mockReturnValue(true);
    harness.updateKeyboard.mockReturnValue(true);

    expect(harness.controller.handleKeyDown(key("c", { ctrlKey: true }))).toBe(false);
    expect(harness.controller.handleKeyDown(key("v", { metaKey: true }))).toBe(false);
    expect(harness.controller.handleKeyDown(key("+", { ctrlKey: true }))).toBe(false);
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.shortcutPaste).not.toHaveBeenCalled();
    expect(harness.updateKeyboard).not.toHaveBeenCalled();
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
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.updateKeyboard).not.toHaveBeenCalled();
  });
});

describe("active editor keyboard owner-document boundary", () => {
  it("rejects hover zoom from a different owning document", () => {
    const harness = keyboardHarness();
    harness.updateKeyboard.mockReturnValue(true);
    const foreignView = { document: {} } as Window;

    expect(harness.controller.handleHoverZoom(key("+", { ctrlKey: true, view: foreignView }))).toBe(
      false,
    );
    expect(harness.updateKeyboard).not.toHaveBeenCalled();
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
    expect(editing.controller.handlePaste(data)).toBe(false);
    expect(available.controller.handlePaste(data)).toBe(true);
    expect(outside.pasteFromClipboardData).not.toHaveBeenCalled();
    expect(editing.pasteFromClipboardData).not.toHaveBeenCalled();
    expect(available.pasteFromClipboardData).toHaveBeenCalledWith(data);
  });

  it("reports the locked-embed requirement instead of consuming absent Canvas history", () => {
    const harness = keyboardHarness();

    expect(harness.controller.handleKeyDown(key("z", { ctrlKey: true }))).toBe(true);
    expect(harness.onNotice).toHaveBeenCalledWith(
      "The embed must be locked to continue undoing in Obsidian.",
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
