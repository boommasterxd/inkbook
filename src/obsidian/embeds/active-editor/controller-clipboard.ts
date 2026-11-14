import {
  beginClipboardWriteDuringActivation,
  type ClipboardWritePayload,
  type ClipboardWritePort,
  type PasteInvocation,
  type PasteRepeatState,
  type VersionedSelectionRecord,
} from "../../../persistence/clipboard/public";

import type { EditableDocumentModel } from "../document-session/vault-document-session";
import {
  ClipboardAdoptionGuard,
  captureClipboardDocumentBasis,
  clipboardDocumentBasisCurrent,
} from "./clipboard-adoption-guard";
import { registerAppliedDocumentMutation } from "./document-history";
import {
  readClipboardCandidates,
  readSynchronousClipboardCandidates,
  hasInkbookClipboardCandidate,
  ordinaryClipboardSource,
  type SynchronousClipboardData,
  type TextClipboardCandidates,
} from "./clipboard-reader";
import type { ActiveEditorHistory } from "./history";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { capturePastePlan } from "../../../persistence/clipboard/paste-plan-snapshot";
import { copyTextSelection } from "./clipboard-text-copy";

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
        | "plain-system-write-failed"
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
  readonly onPasteText?: (source: string, invocation: PasteInvocation) => Promise<boolean>;
  readonly onResult: (result: ClipboardControllerResult) => void;
  readonly onSelectionChanged: (selection: ReadonlySet<string>) => void;
  readonly ownerWindow: Window;
  readonly workScheduler: WorkScheduler;
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
    const blob = text.then((value) => new ownerWindow.Blob([value], { type: mime }));
    void blob.catch(() => undefined);
    data[mime] = blob;
  }
  return new ownerWindow.ClipboardItem(data);
}

export class ActiveEditorClipboardController {
  readonly #abort = new AbortController();
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
  readonly #onPasteText: ActiveEditorClipboardOptions["onPasteText"];
  readonly #ownerWindow: Window;
  readonly #workScheduler: WorkScheduler;
  #operationGeneration = 0;
  #pending = false;
  #repeatState: PasteRepeatState | undefined;
  #sessionPayload: ClipboardWritePayload | undefined;
  #sessionPlainText: string | undefined;
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
    this.#onPasteText = options.onPasteText;
    this.#onResult = options.onResult;
    this.#onSelectionChanged = options.onSelectionChanged;
    this.#ownerWindow = options.ownerWindow;
    this.#workScheduler = options.workScheduler;
  }

  get canPaste(): boolean {
    return (
      !this.#pending &&
      (typeof this.#ownerWindow.navigator.clipboard?.read === "function" || this.hasPastePayload)
    );
  }

  get hasPastePayload(): boolean {
    return this.#sessionPayload !== undefined || this.#sessionPlainText !== undefined;
  }

  get canCopyOrCut(): boolean {
    return !this.#pending;
  }

  get pending(): boolean {
    return this.#pending;
  }

  dispose(): void {
    this.#beginOperation();
    this.#abort.abort();
    this.#adoptionGuard.dispose();
  }

  copy(selection: ReadonlySet<string>): Promise<ClipboardControllerResult> {
    return this.#runExclusive("copy", (operation) => this.#copyOrCut(selection, false, operation));
  }

  copyText(selection: ReadonlySet<string>): Promise<ClipboardControllerResult> {
    return this.#runExclusive("copy", async (operation) => {
      if (selection.size === 0) return this.#reportUnavailable("copy", "empty-selection");
      const snapshot = new Set(selection);
      const version = this.#model.store.mutationVersion;
      const isCurrent = () =>
        this.#isOperationCurrent(operation) &&
        this.#isPresentationAttached() &&
        this.#model.store.mutationVersion === version;
      this.#sessionPayload = undefined;
      this.#sessionPlainText = undefined;
      this.#sessionPayloadFresherThanSystem = false;
      this.#onPasteAvailabilityChanged?.(false);
      const result = await copyTextSelection({
        isCurrent,
        isSelectionCurrent: () => sameSelection(snapshot, this.#currentSelection()),
        port: this.#writePort(),
        scheduler: this.#workScheduler,
        signal: this.#abort.signal,
        selection: snapshot,
        store: this.#model.store,
        timers: this.#ownerWindow,
      });
      if (result.kind === "unavailable") return this.#reportUnavailable("copy", result.reason);
      if (!isCurrent() || !sameSelection(snapshot, this.#currentSelection()))
        return this.#reportUnavailable("copy", "stale-operation");
      this.#sessionPlainText = result.source;
      this.#onPasteAvailabilityChanged?.(true);
      return this.#report({ action: "copy", kind: "copied" });
    });
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
    if (
      candidates === null ||
      (!hasInkbookClipboardCandidate(candidates) && this.#onPasteText === undefined)
    ) {
      this.#reportUnavailable("paste", this.#pending ? "busy" : "invalid-payload");
      return true;
    }
    this.#sessionPayloadFresherThanSystem = false;
    void this.#runExclusive("paste", (operation) => this.#paste(invocation, operation, candidates));
    return true;
  }

  async #paste(
    invocation: PasteInvocation,
    operationGeneration: number,
    suppliedCandidates?: TextClipboardCandidates,
  ): Promise<ClipboardControllerResult> {
    const basis = captureClipboardDocumentBasis(this.#model);
    const candidates = suppliedCandidates ?? (await this.#readCandidates());
    if (!this.#isOperationCurrent(operationGeneration) || !this.#isPresentationAttached()) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    if (candidates === null) {
      return this.#reportUnavailable("paste", "clipboard-read-failed");
    }
    if (!clipboardDocumentBasisCurrent(this.#model, basis)) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    if (this.#onPasteText !== undefined && !hasInkbookClipboardCandidate(candidates)) {
      return this.#pasteText(candidates, invocation, operationGeneration);
    }
    const previousRepeat = invocation.kind === "context-menu" ? undefined : this.#repeatState;
    const candidate = await this.#model.planClipboardPaste(candidates, invocation, previousRepeat);
    const plan = candidate === null ? null : capturePastePlan(candidate);
    if (!this.#isOperationCurrent(operationGeneration)) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    if (!clipboardDocumentBasisCurrent(this.#model, basis, plan)) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    if (plan === null) return this.#pasteText(candidates, invocation, operationGeneration);
    const applied = await this.#commitPaste(plan, this.#model.revision, operationGeneration);
    if (applied === null) {
      return this.#reportUnavailable("paste", "stale-operation");
    }
    registerAppliedDocumentMutation(this.#history, this.#model, applied);
    this.#repeatState = invocation.kind === "context-menu" ? undefined : plan.repeatState;
    this.#onSelectionChanged(new Set(plan.selectedIds));
    this.#onPasteCommitted?.(plan.activateTool, invocation);
    return this.#report({ action: "paste", kind: "committed" });
  }

  async #pasteText(
    candidates: TextClipboardCandidates,
    invocation: PasteInvocation,
    operationGeneration: number,
  ): Promise<ClipboardControllerResult> {
    const source = ordinaryClipboardSource(candidates);
    if (source === null || this.#onPasteText === undefined)
      return this.#reportUnavailable("paste", "invalid-payload");
    if (!this.#isPresentationAttached() || !this.#isOperationCurrent(operationGeneration))
      return this.#reportUnavailable("paste", "stale-operation");
    if (!(await this.#onPasteText(source, invocation)))
      return this.#reportUnavailable("paste", "paste-failed");
    if (!this.#isPresentationAttached() || !this.#isOperationCurrent(operationGeneration))
      return this.#reportUnavailable("paste", "stale-operation");
    this.#repeatState = undefined;
    this.#onPasteCommitted?.("select", invocation);
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
    const cancelled = () =>
      this.#model.revision !== expectedRevision ||
      !this.#isPresentationAttached() ||
      !this.#isOperationCurrent(operationGeneration);
    const currentSelection = () =>
      sameSelection(selection, this.#currentSelection()) &&
      currentSelectionRecords(this.#model, selected);
    if (cancelled() || !currentSelection()) return false;
    const prepared = await this.#model.prepareElementRemoval(selection, { isCancelled: cancelled });
    if (prepared.token === null || cancelled() || !currentSelection()) return false;
    const applied = this.#model.commitPreparedElementMutation(prepared.token);
    if (applied === null) return false;
    registerAppliedDocumentMutation(this.#history, this.#model, applied);
    return true;
  }

  async #commitPaste(
    plan: import("../../../persistence/clipboard/public").PastePlan,
    expectedRevision: number,
    operationGeneration: number,
  ): Promise<import("../../../domain/store/public").AppliedElementMutation | null> {
    const storeVersion = this.#model.store.mutationVersion;
    const cancelled = () =>
      this.#model.revision !== expectedRevision ||
      this.#model.store.mutationVersion !== storeVersion ||
      !this.#isPresentationAttached() ||
      !this.#isOperationCurrent(operationGeneration);
    const preparedAdoption = await this.#adoptionGuard.prepare(plan, {
      isCancelled: cancelled,
      shouldYield: () => this.#workScheduler.shouldYield(),
      yieldControl: () => this.#workScheduler.checkpoint(undefined, "frame") ?? Promise.resolve(),
    });
    if (preparedAdoption === null) return null;
    const validatesCurrentDocument = () =>
      this.#adoptionGuard.accepts(preparedAdoption, this.#model.page);
    if (!validatesCurrentDocument()) return null;
    if (cancelled()) return null;
    const prepared = await this.#model.prepareElementAppend(preparedAdoption.elements, {
      isCancelled: cancelled,
    });
    if (prepared.token === null || cancelled() || !validatesCurrentDocument()) return null;
    return this.#model.commitPreparedElementMutation(prepared.token);
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

  async #encodedPayload(selection: ReadonlySet<string>): Promise<ClipboardWritePayload> {
    const payload = await this.#model.encodeClipboard(selection);
    if (payload === null) throw new Error("Clipboard encoding failed.");
    return payload;
  }

  async #readCandidates(): Promise<TextClipboardCandidates | null> {
    return readClipboardCandidates(
      this.#ownerWindow.navigator.clipboard,
      this.#sessionPlainText === undefined
        ? this.#sessionPayload?.customText
        : { plainText: this.#sessionPlainText },
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
        const wasAvailable = this.hasPastePayload;
        this.#sessionPayload = payload;
        this.#sessionPlainText = undefined;
        this.#sessionPayloadFresherThanSystem = true;
        if (!wasAvailable) this.#onPasteAvailabilityChanged?.(true);
      },
      write: (items) => this.#ownerWindow.navigator.clipboard.write([...items]),
    };
  }
}
