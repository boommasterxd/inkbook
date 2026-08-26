import type { InputPoint } from "../../../editor/input/index";
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
  readonly navigation: ActiveEditorNavigation;
  readonly ownerDocument: Document;
  readonly onFeedback: (code: InkbookFeedbackCode) => void;
  readonly onPendingChanged: (pending: boolean) => void;
  readonly openKeyboardMenu: (position: InputPoint) => void;
  readonly lastScreenPointer: () => InputPoint | null;
  readonly selectionSize: () => number;
}

export class ActiveEditorKeyboardController {
  readonly #options: ActiveEditorKeyboardOptions;
  readonly #paneHistory: PaneDocumentHistoryAdapter;
  readonly #unsubscribeHistory: () => void;
  #pointerOver = false;

  public constructor(options: ActiveEditorKeyboardOptions) {
    this.#options = options;
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
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      this.#options.openKeyboardMenu(this.#options.navigation.visibleCenter());
      return true;
    }
    if (this.handleHoverZoom(event)) return true;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      return this.#handleUnifiedHistory(event.shiftKey ? "redo" : "undo");
    }
    if (isUnmodifiedDelete(event) && this.#options.actions.isAvailable("delete")) {
      this.#options.actions.execute("delete");
      return true;
    }
    if (event.key === "Escape") return this.#handleEscape();
    return this.#handleClipboardShortcut(event);
  }

  public handleHoverZoom(event: KeyboardEvent): boolean {
    if (
      event.view !== null &&
      event.view !== undefined &&
      event.view.document !== this.#options.ownerDocument
    )
      return false;
    if (!this.#pointerOver || isTextField(event.target, this.#options.activeElement()))
      return false;
    return this.#options.navigation.updateKeyboard(event, this.#options.lastScreenPointer());
  }

  public handlePaste(data: SynchronousClipboardData | null): boolean {
    if (!this.#pointerOver || isTextField(null, this.#options.activeElement())) return false;
    return this.#options.actions.pasteFromClipboardData(data);
  }

  public recordMarkdownHistory(): void {
    this.#paneHistory.record("markdown");
  }

  public setPointerOver(pointerOver: boolean): void {
    this.#pointerOver = pointerOver;
  }

  #handleClipboardShortcut(event: KeyboardEvent): boolean {
    const action = (event.ctrlKey || event.metaKey) && event.key.toLowerCase();
    const clipboardAction = action === "c" ? "copy" : action === "x" ? "cut" : "paste";
    if (action !== "c" && action !== "x" && action !== "v") return false;
    if (
      !shouldHandleClipboardShortcut(clipboardAction, {
        hasSelection: this.#options.selectionSize() > 0,
        hasValidInkPayload: this.#options.actions.canPaste,
        pointerOverActiveEditor: this.#pointerOver,
        textFieldFocused: false,
      }) ||
      !this.#options.actions.isAvailable(clipboardAction)
    ) {
      return false;
    }
    if (clipboardAction === "paste") {
      this.#options.actions.shortcutPaste();
      return true;
    }
    this.#options.actions.execute(clipboardAction);
    return true;
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

function isUnmodifiedDelete(event: KeyboardEvent): boolean {
  return event.key === "Delete" && !event.altKey && !event.ctrlKey && !event.metaKey;
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
