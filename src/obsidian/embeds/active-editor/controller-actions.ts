import { arrangeRenderBand, type ArrangeAction } from "../../../domain/commands/arrange";
import type { PasteInvocation } from "../../../persistence/clipboard/public";
import {
  TOOLBAR_ACTION_CONFIRMATION_MS,
  type ToolbarActionConfirmation,
} from "../../../rendering/ui/toolbar-types";
import type { InkbookFeedbackCode } from "../../feedback";
import type { ContextMenuAction } from "../../menus/index";
import type { EditableDocumentModel } from "../vault-document-session";

import { ActiveEditorClipboardController } from "./controller-clipboard";
import { readClipboardCandidates, type SynchronousClipboardData } from "./clipboard-reader";
import { isClipboardAction } from "./controller-helpers";
import {
  arrangeSelectionAvailability,
  canArrangeSelection,
  selectedElements,
} from "./controller-elements";
import { ActiveDocumentHistory } from "./document-history";
import type { ActiveEditorHistory } from "./history";
import type { ElementSceneStore } from "./scene-store";

export interface ActiveEditorActionsOptions {
  readonly confirmEraseAll?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly currentSelection: () => ReadonlySet<string>;
  readonly history: ActiveEditorHistory;
  readonly isAttached: () => boolean;
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
  readonly #confirmEraseAll: ActiveEditorActionsOptions["confirmEraseAll"];
  readonly #isAttached: () => boolean;
  #eraseConfirmation: AbortController | undefined;
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
  readonly #systemClipboardReadable: boolean;
  #actionConfirmation: ToolbarActionConfirmation | null = null;
  #confirmationSequence = 0;
  #confirmationTimer: number | undefined;
  #pasteProbe: Promise<boolean> | undefined;
  #pasteProbeGeneration = 0;

  public constructor(options: ActiveEditorActionsOptions) {
    this.#confirmEraseAll = options.confirmEraseAll;
    this.#isAttached = options.isAttached;
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
    this.#systemClipboardReadable =
      typeof options.ownerWindow.navigator.clipboard?.read === "function";
    this.#documentHistory = new ActiveDocumentHistory({
      history: options.history,
      model: options.model,
      onPendingChanged: options.onPendingChanged,
    });
    this.#clipboard = new ActiveEditorClipboardController({
      currentSelection: options.currentSelection,
      history: options.history,
      isPresentationAttached: options.isAttached,
      model: options.model,
      onPasteAvailabilityChanged: () => options.onStateChanged(),
      onPasteCommitted: (_activeTool, invocation) => {
        if (invocation.kind !== "context-menu") options.onPasteCommitted();
      },
      onPendingChanged: options.onPendingChanged,
      onResult: (result) => {
        if (result.kind === "copied" || result.kind === "committed") {
          this.#confirmClipboardAction(result.action);
        }
        const code = feedbackForClipboardResult(result);
        if (code !== undefined && options.isAttached()) this.#onFeedback?.(code);
      },
      onSelectionChanged: options.setSelection,
      ownerWindow: options.ownerWindow,
    });
  }

  public get canPaste(): boolean {
    return this.#clipboard.canCopyOrCut && this.#clipboard.canPaste;
  }

  public get canRequestPaste(): boolean {
    return (
      this.#isEnabled() &&
      !this.#documentHistory.pending &&
      this.#clipboard.canCopyOrCut &&
      (this.canPaste || this.#systemClipboardReadable)
    );
  }

  public get canClaimPasteShortcut(): boolean {
    return (
      this.#systemClipboardReadable || this.#clipboard.hasPastePayload || this.#clipboard.pending
    );
  }

  public get pasteVisible(): boolean {
    return this.#clipboard.hasPastePayload;
  }

  public get actionConfirmation(): ToolbarActionConfirmation | null {
    return this.#actionConfirmation;
  }

  public get hasValidatedPaste(): boolean {
    return this.#clipboard.hasPastePayload;
  }

  public dispose(): void {
    this.cancelPendingConfirmation();
    this.#pasteProbeGeneration += 1;
    this.#clearConfirmationTimer();
    this.#clipboard.dispose();
    this.#documentHistory.dispose();
  }

  public cancelPendingConfirmation(): void {
    this.#eraseConfirmation?.abort();
    this.#eraseConfirmation = undefined;
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
    if (action === "erase-all" && this.#eraseConfirmation !== undefined) return;
    if (isClipboardAction(action)) {
      this.#executeClipboard(action, invocation);
      return;
    }
    if (!this.isAvailable(action)) {
      throw new Error(`Inkbook action is unavailable: ${action}`);
    }
    if (action === "delete") void this.#deleteSelection();
    else if (isArrangeAction(action)) this.#arrange(action);
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
    this.execute("paste", {
      kind: "shortcut",
      lastSessionPointer: this.#lastSessionPointer(),
      visibleCanvasCenter: center,
    });
  }

  public pasteFromClipboardData(data: SynchronousClipboardData | null): boolean {
    if (!this.#isEnabled() || this.#documentHistory.pending) {
      this.#onFeedback?.("clipboard-operation-busy");
      return true;
    }
    this.#invalidatePasteProbe();
    const accepted = this.#clipboard.pasteFromClipboardData(data, {
      kind: "shortcut",
      lastSessionPointer: this.#lastSessionPointer(),
      visibleCanvasCenter: this.#visibleCenter(),
    });
    return accepted;
  }

  #executeClipboard(
    action: "copy" | "cut" | "paste",
    invocation: PasteInvocation | undefined,
  ): void {
    if (!this.#isEnabled() || this.#documentHistory.pending) {
      this.#onFeedback?.("clipboard-operation-busy");
      return;
    }
    const selection = this.#currentSelection();
    if (action === "copy") void this.#clipboard.copy(selection);
    else if (action === "cut") void this.#clipboard.cut(selection);
    else this.#paste(invocation ?? this.#toolbarPaste());
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
    this.#clipboard.setProbedPasteAvailable(valid);
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
        this.#clipboard.setProbedPasteAvailable(false);
      }
    });
  }

  #confirmClipboardAction(action: "copy" | "cut" | "paste"): void {
    this.#clearConfirmationTimer();
    this.#confirmationSequence =
      this.#confirmationSequence === Number.MAX_SAFE_INTEGER ? 1 : this.#confirmationSequence + 1;
    const sequence = this.#confirmationSequence;
    this.#actionConfirmation = { action, sequence };
    this.#onStateChanged();
    const schedule = this.#ownerWindow.setTimeout?.bind(this.#ownerWindow);
    if (schedule === undefined) return;
    this.#confirmationTimer = schedule(() => {
      if (this.#actionConfirmation?.sequence !== sequence) return;
      this.#actionConfirmation = null;
      this.#confirmationTimer = undefined;
      this.#onStateChanged();
    }, TOOLBAR_ACTION_CONFIRMATION_MS);
  }

  #clearConfirmationTimer(): void {
    if (this.#confirmationTimer === undefined) return;
    this.#ownerWindow.clearTimeout?.(this.#confirmationTimer);
    this.#confirmationTimer = undefined;
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
    if (this.#confirmEraseAll === undefined) return;
    const confirmation = new AbortController();
    const revision = this.#model.revision;
    this.#eraseConfirmation = confirmation;
    try {
      const confirmed = await this.#confirmEraseAll(confirmation.signal);
      if (
        !confirmed ||
        confirmation.signal.aborted ||
        !this.#isAttached() ||
        !this.#isEnabled() ||
        this.#model.revision !== revision
      )
        return;
      await this.#removeAll(confirmation.signal);
    } catch {
      if (!confirmation.signal.aborted) this.#onFeedback?.("history-change-failed");
    } finally {
      if (this.#eraseConfirmation === confirmation) this.#eraseConfirmation = undefined;
    }
  }

  async #removeAll(signal: AbortSignal): Promise<void> {
    const ids = [
      ...this.#sceneStore.materializeBandOrder("highlight"),
      ...this.#sceneStore.materializeBandOrder("content"),
    ];
    const outcome = await this.#documentHistory.remove(
      ids,
      () => !signal.aborted && this.#isAttached(),
    );
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
  if (result.kind === "copied" || result.kind === "committed") return undefined;
  if (result.reason === "busy") return "clipboard-operation-busy";
  if (result.reason === "empty-selection") return "clipboard-copy-failed";
  if (result.reason === "encode-failed") return "clipboard-copy-failed";
  if (result.reason === "system-write-failed") return "clipboard-copy-fallback";
  if (result.reason === "clipboard-read-failed") return "clipboard-paste-read-failed";
  if (result.reason === "invalid-payload") return "clipboard-paste-invalid";
  if (result.reason === "paste-failed") return "clipboard-paste-failed";
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
