import {
  beginClipboardWriteDuringActivation,
  type ClipboardCandidates,
  type ClipboardWritePayload,
  type ClipboardWritePort,
  type PasteInvocation,
  type PasteRepeatState,
  type VersionedSelectionRecord,
} from "../../../persistence/clipboard/public";

import type { EditableDocumentModel } from "../vault-document-session";
import { ClipboardAdoptionGuard } from "./clipboard-adoption-guard";
import { applyDocumentHistoryMutation } from "./document-history";
import {
  readClipboardCandidates,
  readSynchronousClipboardCandidates,
  type SynchronousClipboardData,
} from "./clipboard-reader";
import type { ActiveEditorHistory } from "./history";

export type ClipboardControllerResult =
  | { readonly action: "copy" | "cut"; readonly kind: "copied" }
  | { readonly action: "cut"; readonly kind: "committed" }
  | { readonly action: "paste"; readonly kind: "committed" }
  | {
      readonly action: "copy" | "cut" | "paste";
      readonly kind: "unavailable";
      readonly reason:
        | "clipboard-read-failed"
        | "busy"
        | "empty-selection"
        | "encode-failed"
        | "invalid-payload"
        | "paste-failed"
        | "stale-operation"
        | "system-write-failed";
    };

export interface ActiveEditorClipboardOptions {
  readonly currentSelection: () => ReadonlySet<string>;
  readonly history: ActiveEditorHistory;
  readonly isPresentationAttached: () => boolean;
  readonly model: EditableDocumentModel;
  readonly onPendingChanged: (pending: boolean) => void;
  readonly onPasteAvailabilityChanged?: (available: boolean) => void;
  readonly onPasteCommitted?: (activeTool: "select", invocation: PasteInvocation) => void;
  readonly onResult: (result: ClipboardControllerResult) => void;
  readonly onSelectionChanged: (selection: ReadonlySet<string>) => void;
  readonly ownerWindow: Window;
}

interface ClipboardItemOwnerWindow extends Window {
  readonly Blob: typeof Blob;
  readonly ClipboardItem: {
    new (items: Record<string, ClipboardItemData>, options?: ClipboardItemOptions): ClipboardItem;
  };
}

function hasClipboardItemConstructor(ownerWindow: Window): ownerWindow is ClipboardItemOwnerWindow {
  return (
    "Blob" in ownerWindow &&
    typeof ownerWindow.Blob === "function" &&
    "ClipboardItem" in ownerWindow &&
    typeof ownerWindow.ClipboardItem === "function"
  );
}

function sameSelection(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

function selectionRecords(
  model: EditableDocumentModel,
  selection: ReadonlySet<string>,
): readonly VersionedSelectionRecord[] | null {
  const records: VersionedSelectionRecord[] = [];
  for (const id of selection) {
    const record = model.store.get(id);
    if (record === undefined) return null;
    records.push({
      geometryVersion: record.geometryVersion,
      id,
      paintVersion: record.paintVersion,
    });
  }
  return records;
}

function currentSelectionRecords(
  model: EditableDocumentModel,
  expected: readonly VersionedSelectionRecord[],
): boolean {
  return expected.every((item) => {
    const current = model.store.get(item.id);
    return (
      current?.geometryVersion === item.geometryVersion &&
      current.paintVersion === item.paintVersion
    );
  });
}

function clipboardItem(
  ownerWindow: Window,
  formats: ReadonlyMap<string, Promise<string>>,
): ClipboardItem {
  if (!hasClipboardItemConstructor(ownerWindow)) {
    throw new TypeError("ClipboardItem is unavailable in the owning window.");
  }
  const data: Record<string, Promise<Blob>> = {};
  for (const [mime, text] of formats) {
    data[mime] = text.then((value) => new ownerWindow.Blob([value], { type: mime }));
  }
  return new ownerWindow.ClipboardItem(data);
}

export class ActiveEditorClipboardController {
  readonly #adoptionGuard: ClipboardAdoptionGuard;
  readonly #currentSelection: () => ReadonlySet<string>;
  readonly #history: ActiveEditorHistory;
  readonly #isPresentationAttached: () => boolean;
  readonly #model: EditableDocumentModel;
  readonly #onResult: (result: ClipboardControllerResult) => void;
  readonly #onPendingChanged: (pending: boolean) => void;
  readonly #onPasteAvailabilityChanged: ((available: boolean) => void) | undefined;
  readonly #onPasteCommitted:
    ((activeTool: "select", invocation: PasteInvocation) => void) | undefined;
  readonly #onSelectionChanged: (selection: ReadonlySet<string>) => void;
  readonly #ownerWindow: Window;
  #operationGeneration = 0;
  #pending = false;
  #pasteAvailable = false;
  #repeatState: PasteRepeatState | undefined;
  #sessionPayload: ClipboardWritePayload | undefined;
  #sessionPayloadFresherThanSystem = false;

  constructor(options: ActiveEditorClipboardOptions) {
    this.#adoptionGuard = new ClipboardAdoptionGuard(options.model.store);
    this.#currentSelection = options.currentSelection;
    this.#history = options.history;
    this.#isPresentationAttached = options.isPresentationAttached;
    this.#model = options.model;
    this.#onPendingChanged = options.onPendingChanged;
    this.#onPasteAvailabilityChanged = options.onPasteAvailabilityChanged;
    this.#onPasteCommitted = options.onPasteCommitted;
    this.#onResult = options.onResult;
    this.#onSelectionChanged = options.onSelectionChanged;
    this.#ownerWindow = options.ownerWindow;
  }

  get canPaste(): boolean {
    return !this.#pending && this.#pasteAvailable;
  }

  get hasPastePayload(): boolean {
    return this.#pasteAvailable;
  }

  get canCopyOrCut(): boolean {
    return !this.#pending;
  }

  get pending(): boolean {
    return this.#pending;
  }

  setProbedPasteAvailable(available: boolean): void {
    if (available || !this.#sessionPayloadFresherThanSystem) this.#setPasteAvailable(available);
  }

  dispose(): void {
    this.#beginOperation();
    this.#adoptionGuard.dispose();
  }

  copy(selection: ReadonlySet<string>): Promise<ClipboardControllerResult> {
    return this.#runExclusive("copy", (operation) => this.#copyOrCut(selection, false, operation));
  }

  cut(selection: ReadonlySet<string>): Promise<ClipboardControllerResult> {
    return this.#runExclusive("cut", (operation) => this.#copyOrCut(selection, true, operation));
  }

  paste(invocation: PasteInvocation): Promise<ClipboardControllerResult> {
    return this.#runExclusive("paste", (operation) => this.#paste(invocation, operation));
  }

  pasteFromClipboardData(
    data: SynchronousClipboardData | null,
    invocation: PasteInvocation,
  ): boolean {
    const candidates = readSynchronousClipboardCandidates(data);
    if (candidates === null) {
      this.#setPasteAvailable(false);
      this.#reportUnavailable("paste", this.#pending ? "busy" : "invalid-payload");
      return true;
    }
    this.#sessionPayloadFresherThanSystem = false;
    this.#setPasteAvailable(true);
    void this.#runExclusive("paste", (operation) => this.#paste(invocation, operation, candidates));
    return true;
  }

  async #paste(
    invocation: PasteInvocation,
    operationGeneration: number,
    suppliedCandidates?: ClipboardCandidates,
  ): Promise<ClipboardControllerResult> {
    const expectedRevision = this.#model.revision;
    const candidates = suppliedCandidates ?? (await this.#readCandidates());
    if (!this.#isOperationCurrent(operationGeneration)) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    if (candidates === null) {
      this.#setPasteAvailable(false);
      return this.#reportUnavailable("paste", "clipboard-read-failed");
    }
    const previousRepeat = invocation.kind === "context-menu" ? undefined : this.#repeatState;
    const plan = await this.#model.planClipboardPaste(candidates, invocation, previousRepeat);
    if (!this.#isOperationCurrent(operationGeneration)) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    if (plan === null) {
      this.#setPasteAvailable(false);
      return this.#reportUnavailable("paste", "invalid-payload");
    }
    const applied = await this.#commitPaste(plan, expectedRevision, operationGeneration);
    if (applied === null) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    this.#registerApplied(applied);
    this.#repeatState = invocation.kind === "context-menu" ? undefined : plan.repeatState;
    this.#setPasteAvailable(true);
    this.#onSelectionChanged(new Set(plan.selectedIds));
    this.#onPasteCommitted?.(plan.activateTool, invocation);
    return this.#report({ action: "paste", kind: "committed" });
  }

  async #copyOrCut(
    selection: ReadonlySet<string>,
    cut: boolean,
    operationGeneration: number,
  ): Promise<ClipboardControllerResult> {
    const action = cut ? "cut" : "copy";
    if (selection.size === 0) return this.#reportUnavailable(action, "empty-selection");
    const selectionSnapshot = new Set(selection);
    const expectedRevision = this.#model.revision;
    const selectedRecords = selectionRecords(this.#model, selectionSnapshot);
    if (selectedRecords === null) return this.#reportUnavailable(action, "stale-operation");
    const payloadReady = this.#encodedPayload(selectionSnapshot);
    const write = beginClipboardWriteDuringActivation(this.#writePort(), payloadReady);
    try {
      await write.payloadReady;
    } catch {
      return this.#reportUnavailable(action, "encode-failed");
    }
    const payload = await write.payloadReady;
    this.#observeSystemWrite(action, payload, write.systemWrite);
    if (!cut) return this.#report({ action, kind: "copied" });
    if (
      !this.#isPresentationAttached() ||
      !this.#isOperationCurrent(operationGeneration) ||
      !sameSelection(selectionSnapshot, this.#currentSelection()) ||
      !(await this.#commitCut(
        selectionSnapshot,
        selectedRecords,
        expectedRevision,
        operationGeneration,
      ))
    ) {
      return this.#reportUnavailable(action, "stale-operation");
    }
    this.#onSelectionChanged(new Set());
    return this.#report({ action: "cut", kind: "committed" });
  }

  #observeSystemWrite(
    action: "copy" | "cut",
    payload: ClipboardWritePayload,
    systemWrite: Promise<boolean>,
  ): void {
    void systemWrite.then((succeeded) => {
      if (this.#sessionPayload !== payload) return;
      this.#sessionPayloadFresherThanSystem = !succeeded;
      if (!succeeded) this.#reportUnavailable(action, "system-write-failed");
    });
  }

  async #commitCut(
    selection: ReadonlySet<string>,
    selected: readonly VersionedSelectionRecord[],
    expectedRevision: number,
    operationGeneration: number,
  ): Promise<boolean> {
    if (!currentSelectionRecords(this.#model, selected)) return false;
    const removed = new Set(selected.map(({ id }) => id));
    const applied = await this.#prepareAndCommit(
      {
        bands: {
          content: this.#model.store
            .materializeBandOrder("content")
            .filter((id) => !removed.has(id)),
          highlight: this.#model.store
            .materializeBandOrder("highlight")
            .filter((id) => !removed.has(id)),
        },
        removeIds: [...removed],
      },
      expectedRevision,
      () =>
        this.#isOperationCurrent(operationGeneration) &&
        sameSelection(selection, this.#currentSelection()) &&
        currentSelectionRecords(this.#model, selected),
    );
    if (applied === null) return false;
    this.#registerApplied(applied);
    return true;
  }

  async #commitPaste(
    plan: import("../../../persistence/clipboard/public").PastePlan,
    expectedRevision: number,
    operationGeneration: number,
  ): Promise<import("../../../domain/store/public").AppliedElementMutation | null> {
    const preparedAdoption = this.#adoptionGuard.prepare(plan);
    if (preparedAdoption === null) return null;
    const validatesCurrentDocument = () =>
      this.#adoptionGuard.accepts(preparedAdoption, this.#model.page);
    if (!validatesCurrentDocument()) return null;
    return this.#prepareAndCommit(
      {
        bands: {
          content: [...this.#model.store.materializeBandOrder("content"), ...plan.contentIds],
          highlight: [...this.#model.store.materializeBandOrder("highlight"), ...plan.highlightIds],
        },
        elements: plan.elements,
      },
      expectedRevision,
      () => this.#isOperationCurrent(operationGeneration),
      validatesCurrentDocument,
    );
  }

  #registerApplied(applied: import("../../../domain/store/public").AppliedElementMutation): void {
    this.#history.registerApplied({
      payloadBytes: applied.payloadBytes,
      redo: () => this.#applyMutation(applied.forward, applied),
      undo: () => this.#applyMutation(applied.reverse, applied),
    });
  }

  #applyMutation(
    mutation: import("../../../domain/store/public").ElementMutation,
    replay: import("../../../domain/store/public").AppliedElementMutation,
  ): Promise<boolean> {
    const operationGeneration = this.#beginOperation();
    return applyDocumentHistoryMutation(
      this.#model,
      mutation,
      replay,
      () => !this.#isPresentationAttached() || !this.#isOperationCurrent(operationGeneration),
    );
  }

  #beginOperation(): number {
    this.#operationGeneration += 1;
    if (!Number.isSafeInteger(this.#operationGeneration)) {
      throw new RangeError("Clipboard operation generation reached Number.MAX_SAFE_INTEGER.");
    }
    return this.#operationGeneration;
  }

  #runExclusive(
    action: ClipboardControllerResult["action"],
    operation: (generation: number) => Promise<ClipboardControllerResult>,
  ): Promise<ClipboardControllerResult> {
    if (this.#pending) return Promise.resolve(this.#reportUnavailable(action, "busy"));
    this.#pending = true;
    const generation = this.#beginOperation();
    this.#onPendingChanged(true);
    return operation(generation)
      .catch(() =>
        this.#reportUnavailable(action, action === "paste" ? "paste-failed" : "encode-failed"),
      )
      .finally(() => {
        this.#pending = false;
        this.#onPendingChanged(false);
      });
  }

  #isOperationCurrent(operationGeneration: number): boolean {
    return operationGeneration === this.#operationGeneration;
  }

  async #prepareAndCommit(
    mutation: import("../../../domain/store/public").ElementMutation,
    expectedRevision: number,
    operationCurrent: () => boolean,
    validateBeforeCommit: () => boolean = () => true,
  ): Promise<import("../../../domain/store/public").AppliedElementMutation | null> {
    if (
      this.#model.revision !== expectedRevision ||
      !this.#isPresentationAttached() ||
      !operationCurrent()
    ) {
      return null;
    }
    const cancelled = () =>
      this.#model.revision !== expectedRevision ||
      !this.#isPresentationAttached() ||
      !operationCurrent();
    const prepared = await this.#model.prepareElementMutation(mutation, {
      isCancelled: cancelled,
    });
    if (prepared.token === null || cancelled() || !validateBeforeCommit()) return null;
    return this.#model.commitPreparedElementMutation(prepared.token);
  }

  async #encodedPayload(selection: ReadonlySet<string>): Promise<ClipboardWritePayload> {
    const payload = await this.#model.encodeClipboard(selection);
    if (payload === null) throw new Error("Clipboard encoding failed.");
    return payload;
  }

  async #readCandidates(): Promise<ClipboardCandidates | null> {
    return readClipboardCandidates(
      this.#ownerWindow.navigator.clipboard,
      this.#sessionPayload?.customText,
      this.#sessionPayloadFresherThanSystem,
    );
  }

  #report<Result extends ClipboardControllerResult>(result: Result): Result {
    this.#onResult(result);
    return result;
  }

  #reportUnavailable(
    action: ClipboardControllerResult["action"],
    reason: Extract<ClipboardControllerResult, { kind: "unavailable" }>["reason"],
  ): ClipboardControllerResult {
    return this.#report({ action, kind: "unavailable", reason });
  }

  #writePort(): ClipboardWritePort<ClipboardItem> {
    return {
      createItem: (formats) => clipboardItem(this.#ownerWindow, formats),
      retainSessionPayload: (payload) => {
        this.#sessionPayload = payload;
        this.#sessionPayloadFresherThanSystem = true;
        this.#setPasteAvailable(true);
      },
      write: (items) => this.#ownerWindow.navigator.clipboard.write([...items]),
    };
  }

  #setPasteAvailable(available: boolean): void {
    if (available === this.#pasteAvailable) return;
    this.#pasteAvailable = available;
    this.#onPasteAvailabilityChanged?.(available);
  }
}
