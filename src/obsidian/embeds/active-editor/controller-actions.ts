import { arrangeRenderBand, type ArrangeAction } from "../../../domain/commands/arrange";
import type { PasteInvocation } from "../../../persistence/clipboard/public";
import type { ContextMenuAction } from "../../menus/index";
import type { EditableDocumentModel } from "../vault-document-session";

import { ActiveEditorClipboardController } from "./controller-clipboard";
import { readClipboardCandidates, type SynchronousClipboardData } from "./clipboard-reader";
import {
  arrangeSelectionAvailability,
  canArrangeSelection,
  selectedElements,
} from "./controller-elements";
import { ActiveDocumentHistory } from "./document-history";
import type { ActiveEditorHistory } from "./history";
import type { ElementSceneStore } from "./scene-store";
import type { InkbookFeedbackCode } from "../../feedback";

export interface ActiveEditorActionsOptions {
  readonly currentSelection: () => ReadonlySet<string>;
  readonly history: ActiveEditorHistory;
  readonly isEnabled: () => boolean;
  readonly model: EditableDocumentModel;
  readonly onCopyEmbed: () => void;
  readonly onDeleteEmbed: () => void;
  readonly onFeedback?: (code: InkbookFeedbackCode) => void;
  readonly onPasteCommitted: () => void;
  readonly onPendingChanged: (pending: boolean) => void;
  readonly onStateChanged: () => void;
  readonly ownerWindow: Window;
  readonly sceneStore: ElementSceneStore;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly visibleCenter: () => { readonly x: number; readonly y: number };
  readonly lastSessionPointer: () => { readonly x: number; readonly y: number } | null;
}

export class ActiveEditorActions {
  readonly #clipboard: ActiveEditorClipboardController;
  readonly #currentSelection: () => ReadonlySet<string>;
  readonly #documentHistory: ActiveDocumentHistory;
  readonly #history: ActiveEditorHistory;
  readonly #isEnabled: () => boolean;
  readonly #model: EditableDocumentModel;
  readonly #onCopyEmbed: () => void;
  readonly #onDeleteEmbed: () => void;
  readonly #onFeedback: ((code: InkbookFeedbackCode) => void) | undefined;
  readonly #onStateChanged: () => void;
  readonly #ownerWindow: Window;
  readonly #sceneStore: ElementSceneStore;
  readonly #setSelection: (selection: ReadonlySet<string>) => void;
  readonly #visibleCenter: () => { readonly x: number; readonly y: number };
  readonly #lastSessionPointer: () => { readonly x: number; readonly y: number } | null;
  #externalPasteAvailable = false;
  #pasteProbe: Promise<boolean> | undefined;
  #pasteProbeGeneration = 0;

  public constructor(options: ActiveEditorActionsOptions) {
    this.#currentSelection = options.currentSelection;
    this.#history = options.history;
    this.#isEnabled = options.isEnabled;
    this.#model = options.model;
    this.#onCopyEmbed = options.onCopyEmbed;
    this.#onDeleteEmbed = options.onDeleteEmbed;
    this.#onFeedback = options.onFeedback;
    this.#onStateChanged = options.onStateChanged;
    this.#ownerWindow = options.ownerWindow;
    this.#sceneStore = options.sceneStore;
    this.#setSelection = options.setSelection;
    this.#visibleCenter = options.visibleCenter;
    this.#lastSessionPointer = options.lastSessionPointer;
    this.#documentHistory = new ActiveDocumentHistory({
      history: options.history,
      model: options.model,
      onPendingChanged: options.onPendingChanged,
    });
    this.#clipboard = new ActiveEditorClipboardController({
      currentSelection: options.currentSelection,
      history: options.history,
      isPresentationAttached: options.isEnabled,
      model: options.model,
      onPasteAvailabilityChanged: (available) => {
        if (!available) this.#externalPasteAvailable = false;
        if (!this.#externalPasteAvailable || !available) options.onStateChanged();
      },
      onPasteCommitted: () => options.onPasteCommitted(),
      onPendingChanged: options.onPendingChanged,
      onResult: (result) => {
        const code = feedbackForClipboardResult(result);
        if (code !== undefined && options.isEnabled()) this.#onFeedback?.(code);
      },
      onSelectionChanged: options.setSelection,
      ownerWindow: options.ownerWindow,
    });
  }

  public get canPaste(): boolean {
    return this.#clipboard.canPaste || this.#externalPasteAvailable;
  }

  public dispose(): void {
    this.#pasteProbeGeneration += 1;
    this.#clipboard.dispose();
    this.#documentHistory.dispose();
  }

  public canArrange(action: ArrangeAction): boolean {
    return canArrangeSelection(this.#sceneStore, this.#currentSelection(), action);
  }

  public arrangeAvailability(): Readonly<Record<ArrangeAction, boolean>> {
    return arrangeSelectionAvailability(this.#sceneStore, this.#currentSelection());
  }

  public refreshPasteAvailability(): Promise<boolean> {
    if (!this.#isEnabled()) return Promise.resolve(this.canPaste);
    if (this.#pasteProbe !== undefined) return this.#pasteProbe;
    const generation = this.#invalidatePasteProbe();
    const probe = this.#probeSystemClipboard(generation).finally(() => {
      if (this.#pasteProbe === probe) this.#pasteProbe = undefined;
    });
    this.#pasteProbe = probe;
    return probe;
  }

  public execute(action: ContextMenuAction, invocation?: PasteInvocation): void {
    if (!this.isAvailable(action)) throw new Error(`Inkbook action is unavailable: ${action}`);
    const selection = this.#currentSelection();
    if (action === "copy") void this.#clipboard.copy(selection);
    else if (action === "cut") void this.#clipboard.cut(selection);
    else if (action === "delete") void this.#deleteSelection();
    else if (action === "paste") {
      this.#paste(invocation ?? this.#toolbarPaste());
    } else if (isArrangeAction(action)) this.#arrange(action);
    else if (action === "erase-all") void this.#eraseAll();
    else if (action === "copy-embed") this.#onCopyEmbed();
    else if (action === "delete-embed") this.#onDeleteEmbed();
  }

  public isAvailable(action: ContextMenuAction): boolean {
    if (!this.#isEnabled() || this.#documentHistory.pending) return false;
    if (action === "copy" || action === "cut" || action === "delete") {
      return (
        this.#currentSelection().size > 0 && (action === "delete" || this.#clipboard.canCopyOrCut)
      );
    }
    if (action === "erase-all") return this.#model.store.size > 0;
    if (action === "paste") return this.canPaste;
    if (isArrangeAction(action)) return this.canArrange(action);
    return action === "copy-embed" || action === "delete-embed";
  }

  public shortcutPaste(): void {
    const center = this.#visibleCenter();
    this.#paste({
      kind: "shortcut",
      lastSessionPointer: this.#lastSessionPointer(),
      visibleCanvasCenter: center,
    });
  }

  public pasteFromClipboardData(data: SynchronousClipboardData | null): boolean {
    this.#invalidatePasteProbe();
    const accepted = this.#clipboard.pasteFromClipboardData(data, {
      kind: "shortcut",
      lastSessionPointer: this.#lastSessionPointer(),
      visibleCanvasCenter: this.#visibleCenter(),
    });
    if (!accepted) this.#setExternalPasteAvailable(false);
    return accepted;
  }

  #arrange(action: ArrangeAction): void {
    const selection = this.#currentSelection();
    const previous = {
      content: this.#sceneStore.materializeBandOrder("content"),
      highlight: this.#sceneStore.materializeBandOrder("highlight"),
    };
    const replacement = {
      content: arrangeRenderBand(previous.content, (id) => selection.has(id), action).elements,
      highlight: arrangeRenderBand(previous.highlight, (id) => selection.has(id), action).elements,
    };
    this.#history.reorder(previous, replacement);
  }

  async #probeSystemClipboard(generation: number): Promise<boolean> {
    const candidates = await readClipboardCandidates(this.#ownerWindow.navigator.clipboard);
    if (candidates === null || generation !== this.#pasteProbeGeneration || !this.#isEnabled()) {
      return this.canPaste;
    }
    let valid = false;
    try {
      valid = (await this.#model.planClipboardPaste(candidates, this.#toolbarPaste())) !== null;
    } catch {
      return this.canPaste;
    }
    if (generation !== this.#pasteProbeGeneration || !this.#isEnabled()) return this.canPaste;
    this.#setExternalPasteAvailable(valid);
    return this.canPaste;
  }

  #invalidatePasteProbe(): number {
    this.#pasteProbeGeneration += 1;
    this.#pasteProbe = undefined;
    return this.#pasteProbeGeneration;
  }

  #paste(invocation: PasteInvocation): void {
    const generation = this.#invalidatePasteProbe();
    void this.#clipboard.paste(invocation).then((result) => {
      if (
        generation === this.#pasteProbeGeneration &&
        result.kind === "unavailable" &&
        (result.reason === "clipboard-read-failed" || result.reason === "invalid-payload")
      ) {
        this.#setExternalPasteAvailable(false);
      }
    });
  }

  #setExternalPasteAvailable(available: boolean): void {
    const availableBefore = this.canPaste;
    this.#externalPasteAvailable = available;
    if (availableBefore !== this.canPaste) this.#onStateChanged();
  }

  async #deleteSelection(): Promise<void> {
    const selection = this.#currentSelection();
    const ids = selectedElements(this.#sceneStore, selection).map(({ id }) => id);
    const outcome = await this.#documentHistory.remove(ids, () =>
      sameSelection(selection, this.#currentSelection()),
    );
    if (outcome === "applied") this.#setSelection(new Set());
    else if (outcome === "failed" || outcome === "stale") {
      this.#onFeedback?.("history-change-failed");
    }
  }

  async #eraseAll(): Promise<void> {
    if (!this.#ownerWindow.confirm("Erase all Inkbook elements?")) return;
    const ids = [
      ...this.#sceneStore.materializeBandOrder("highlight"),
      ...this.#sceneStore.materializeBandOrder("content"),
    ];
    const outcome = await this.#documentHistory.remove(ids);
    if (outcome === "applied") this.#setSelection(new Set());
    else if (outcome === "failed" || outcome === "stale") {
      this.#onFeedback?.("history-change-failed");
    }
  }

  #toolbarPaste(): PasteInvocation {
    return { kind: "toolbar", visibleCanvasCenter: this.#visibleCenter() };
  }
}

function feedbackForClipboardResult(
  result: import("./controller-clipboard").ClipboardControllerResult,
): InkbookFeedbackCode | undefined {
  if (result.kind === "copied" || result.kind === "committed") {
    return "systemWriteSucceeded" in result && !result.systemWriteSucceeded
      ? "clipboard-copy-fallback"
      : undefined;
  }
  if (result.reason === "encode-failed") return "clipboard-copy-failed";
  if (result.reason === "clipboard-read-failed") return "clipboard-paste-read-failed";
  if (result.reason === "invalid-payload") return "clipboard-paste-invalid";
  if (result.reason === "stale-operation") {
    if (result.action === "cut") return "cut-selection-changed";
    return result.action === "paste" ? "clipboard-paste-stale" : "clipboard-copy-failed";
  }
  return undefined;
}

function sameSelection(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function isArrangeAction(action: ContextMenuAction): action is ArrangeAction {
  return (
    action === "bring-forward" ||
    action === "send-backward" ||
    action === "bring-to-front" ||
    action === "send-to-back"
  );
}
