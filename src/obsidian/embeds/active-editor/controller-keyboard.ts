import type { InputPoint } from "../../../editor/input/index";
import { resolveConfiguredShortcut } from "../../../editor/input/index";
import {
  createBuiltInKeyboardShortcuts,
  type KeyboardShortcutSettingsV1,
} from "../../../domain/settings/index";
import { shouldHandleClipboardShortcut } from "../../../persistence/clipboard/public";

import type { ActiveEditorActions } from "./controller-actions";
import type { SynchronousClipboardData } from "./clipboard-reader";
import { PaneDocumentHistoryAdapter, type UnifiedHistoryDirection } from "./document-history";
import type { ActiveEditorHistory } from "./history";
import type { ActiveEditorNavigation } from "./navigation";
import type { InkbookFeedbackCode } from "../../feedback";

export interface ActiveEditorKeyboardOptions {
  readonly activeElement: () => Element | null;
  readonly actions: ActiveEditorActions;
  readonly cancelGesture: () => boolean;
  readonly clearSelection: () => void;
  readonly closeFlyout: () => boolean;
  readonly history: ActiveEditorHistory;
  readonly keyboardShortcuts?: KeyboardShortcutSettingsV1;
  readonly navigation: ActiveEditorNavigation;
  readonly navigationEnabled: () => boolean;
  readonly ownerDocument: Document;
  readonly onFeedback: (code: InkbookFeedbackCode) => void;
  readonly onPendingChanged: (pending: boolean) => void;
  readonly openKeyboardMenu: (position: InputPoint) => void;
  readonly selectAll: () => void;
  readonly lastScreenPointer: () => InputPoint | null;
  readonly selectionSize: () => number;
}

export class ActiveEditorKeyboardController {
  readonly #options: ActiveEditorKeyboardOptions;
  readonly #paneHistory: PaneDocumentHistoryAdapter;
  #shortcuts: KeyboardShortcutSettingsV1;
  readonly #unsubscribeHistory: () => void;
  #pointerOver = false;

  public constructor(options: ActiveEditorKeyboardOptions) {
    this.#options = options;
    this.#shortcuts = structuredClone(
      options.keyboardShortcuts ?? createBuiltInKeyboardShortcuts(),
    );
    this.#paneHistory = new PaneDocumentHistoryAdapter({
      redo: () => options.history.redoAsync(),
      undo: () => options.history.undoAsync(),
    });
    this.#unsubscribeHistory = options.history.subscribeCommitted(() =>
      this.#paneHistory.record("canvas"),
    );
  }

  public dispose(): void {
    this.#unsubscribeHistory();
    this.#paneHistory.clear();
  }

  public handleKeyDown(event: KeyboardEvent): boolean {
    const textFieldFocused = isTextField(event.target, this.#options.activeElement());
    if (textFieldFocused) return false;
    if (event.key === "F10" && event.shiftKey) {
      this.#options.openKeyboardMenu(this.#options.navigation.visibleCenter());
      return true;
    }
    if (isHistoryShortcut(event)) {
      return this.#handleUnifiedHistory(event.shiftKey ? "redo" : "undo");
    }
    if (event.key === "Escape") return this.#handleEscape();
    return (
      this.#handleConfiguredShortcut(event, true) || this.#handleFixedPasteShortcut(event, true)
    );
  }

  public handleDocumentKeyDown(event: KeyboardEvent): boolean {
    if (isTextField(event.target, this.#options.activeElement())) return false;
    if (!this.#pointerOver) return false;
    if (isHistoryShortcut(event)) {
      return this.#handleUnifiedHistory(event.shiftKey ? "redo" : "undo");
    }
    return (
      this.#handleConfiguredShortcut(event, false) || this.#handleFixedPasteShortcut(event, false)
    );
  }

  public handlePendingClipboardKeyDown(event: KeyboardEvent): boolean {
    if (isTextField(event.target, this.#options.activeElement())) return false;
    const action = resolveConfiguredShortcut(event, this.#shortcuts);
    if (action === "copy" || action === "cut") {
      if (!this.#clipboardActionAvailable(action, true)) return false;
      this.#options.actions.execute(action);
      return true;
    }
    return this.#handleFixedPasteShortcut(event, true);
  }

  public handleHoverZoom(event: KeyboardEvent): boolean {
    const action = resolveConfiguredShortcut(event, this.#shortcuts);
    if (action !== "zoom-in" && action !== "zoom-out") return false;
    return this.#handleZoom(event, action === "zoom-in" ? 1 : -1);
  }

  public updateShortcuts(shortcuts: KeyboardShortcutSettingsV1): void {
    this.#shortcuts = structuredClone(shortcuts);
  }

  #handleZoom(event: KeyboardEvent, step: -1 | 1): boolean {
    if (
      event.view !== null &&
      event.view !== undefined &&
      event.view.document !== this.#options.ownerDocument
    )
      return false;
    if (!this.#pointerOver || isTextField(event.target, this.#options.activeElement()))
      return false;
    if (!this.#options.navigationEnabled()) return true;
    return this.#options.navigation.updateKeyboardStep(step, this.#options.lastScreenPointer());
  }

  public handlePaste(data: SynchronousClipboardData | null, surfaceOwned = false): boolean {
    if ((!surfaceOwned && !this.#pointerOver) || isTextField(null, this.#options.activeElement()))
      return false;
    return this.#options.actions.pasteFromClipboardData(data);
  }

  public recordMarkdownHistory(): void {
    this.#paneHistory.record("markdown");
  }

  public setPointerOver(pointerOver: boolean): void {
    this.#pointerOver = pointerOver;
  }

  #handleFixedPasteShortcut(event: KeyboardEvent, surfaceOwned: boolean): boolean {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== "v"
    ) {
      return false;
    }
    if ((!surfaceOwned && !this.#pointerOver) || !this.#options.actions.canClaimPasteShortcut)
      return false;
    this.#options.actions.shortcutPaste();
    return true;
  }

  #handleConfiguredShortcut(event: KeyboardEvent, surfaceOwned: boolean): boolean {
    const action = resolveConfiguredShortcut(event, this.#shortcuts);
    if (action === undefined) return false;
    if (action === "zoom-in" || action === "zoom-out") {
      return this.#handleZoom(event, action === "zoom-in" ? 1 : -1);
    }
    if (action === "select-all") {
      this.#options.selectAll();
      return true;
    }
    const canvasAction = action === "delete-selection" ? "delete" : action;
    if (
      (canvasAction === "copy" || canvasAction === "cut") &&
      !this.#clipboardActionAvailable(canvasAction, surfaceOwned)
    ) {
      return false;
    }
    if (
      canvasAction !== "copy" &&
      canvasAction !== "cut" &&
      !this.#options.actions.isAvailable(canvasAction)
    )
      return false;
    this.#options.actions.execute(canvasAction);
    return true;
  }

  #clipboardActionAvailable(action: "copy" | "cut", surfaceOwned: boolean): boolean {
    return shouldHandleClipboardShortcut(action, {
      hasSelection: this.#options.selectionSize() > 0,
      hasValidInkPayload: this.#options.actions.hasValidatedPaste,
      pointerOverActiveEditor: surfaceOwned || this.#pointerOver,
      textFieldFocused: false,
    });
  }

  #handleEscape(): boolean {
    if (this.#options.closeFlyout()) return true;
    if (this.#options.cancelGesture()) return true;
    if (this.#options.selectionSize() === 0) return false;
    this.#options.clearSelection();
    return true;
  }

  #handleUnifiedHistory(direction: UnifiedHistoryDirection): boolean {
    const outcome = this.#paneHistory.handleShortcut(direction, false);
    if (outcome.status === "lock-notice") {
      this.#options.onFeedback("history-lock-required");
      return true;
    }
    if (outcome.status !== "canvas") return false;
    this.#options.onPendingChanged(true);
    void outcome.completion
      .then((result) => {
        if (result.status === "failed") this.#options.onFeedback("history-change-failed");
      })
      .finally(() => this.#options.onPendingChanged(false));
    return true;
  }
}

function isHistoryShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z";
}

function isTextField(target: EventTarget | null, activeElement: Element | null): boolean {
  return isEditableElement(target) || isEditableElement(activeElement);
}

function isEditableElement(value: EventTarget | null | undefined): boolean {
  if (value === null || value === undefined || !("nodeType" in value)) return false;
  let element: Element | null = value as Element;
  while (element !== null) {
    const tagName = element.tagName?.toLowerCase();
    if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
    const contentEditable = element.getAttribute?.("contenteditable");
    if (contentEditable !== null && contentEditable !== undefined) {
      return contentEditable.toLowerCase() !== "false";
    }
    element = element.parentElement;
  }
  return false;
}
