import { AppliedCommandHistory } from "../../../domain/commands/history";
import type { RenderBand } from "../../../domain/commands/render-bands";
import type { InkElementV1, PageV1 } from "../../../domain/schema/public";
import type { DocumentMutationAvailability } from "../document-model-port";
import type { SelectionFrameHistoryEffect } from "../../../editor/selection/public";
import type { ElementReplacementHistoryData } from "../../../domain/store/public";

export type ActiveEditorBandOrder = Readonly<Record<RenderBand, readonly string[]>>;

export interface ActiveEditorHistoryModel {
  readonly mutationAvailability?: DocumentMutationAvailability;
  beginInteractiveOperation?(): () => void;
  commitBandOrder(order: ActiveEditorBandOrder): void;
  commitElements(elements: readonly InkElementV1[]): void;
  commitPage(page: PageV1): void;
  removeElements(ids: readonly string[]): void;
  replaceElements(
    elements: readonly InkElementV1[],
    capture?: (history: ElementReplacementHistoryData) => void,
  ): void;
}

interface SynchronousEditorMutation {
  readonly apply: () => void;
  readonly payloadBytes: number;
  readonly revert: () => void;
}

export interface AppliedAsyncHistoryTransition {
  readonly payloadBytes: number;
  readonly redo: () => Promise<boolean>;
  readonly undo: () => Promise<boolean>;
}

type CommitListener = () => void;

export class ActiveEditorHistory {
  readonly #committedListeners = new Set<CommitListener>();
  #disposed = false;
  #history = new AppliedCommandHistory();
  #replayDepth = 0;
  readonly #model: ActiveEditorHistoryModel;

  public constructor(model: ActiveEditorHistoryModel) {
    this.#model = model;
  }

  public get canRedo(): boolean {
    return this.#history.canRedo;
  }

  public get canUndo(): boolean {
    return this.#history.canUndo;
  }

  public get commandCount(): number {
    return this.#history.commandCount;
  }

  public get isTraversing(): boolean {
    return this.#history.isTraversing;
  }

  public get isReplaying(): boolean {
    return this.#replayDepth > 0;
  }

  public get isDisposed(): boolean {
    return this.#disposed;
  }

  public get retainedPayloadBytes(): number {
    return this.#history.retainedBytes;
  }

  public create(elements: readonly InkElementV1[]): boolean {
    if (elements.length === 0) return false;
    return this.#execute({
      apply: () => this.#model.commitElements(elements),
      payloadBytes: estimateElementHistoryPayloadBytes(elements),
      revert: () => this.#model.removeElements(elements.map(({ id }) => id)),
    });
  }

  public reorder(previous: ActiveEditorBandOrder, replacement: ActiveEditorBandOrder): boolean {
    if (sameBandOrder(previous, replacement)) return false;
    return this.#execute({
      apply: () => this.#model.commitBandOrder(replacement),
      payloadBytes: estimateBandOrderPayloadBytes(previous, replacement),
      revert: () => this.#model.commitBandOrder(previous),
    });
  }

  public replace(
    previous: readonly InkElementV1[],
    replacements: readonly InkElementV1[],
    effect?: SelectionFrameHistoryEffect,
  ): boolean {
    if (previous.length === 0 || previous.length !== replacements.length) return false;
    const captured = captureElementReplacementHistory(previous, replacements);
    let initialCommit = true;
    return this.#execute({
      apply: () => {
        if (initialCommit) {
          this.#model.replaceElements(
            captured.replacements as readonly InkElementV1[],
            captured.capture,
          );
          initialCommit = false;
        } else {
          this.#model.replaceElements(captured.replacements as readonly InkElementV1[]);
        }
        effect?.apply();
      },
      get payloadBytes() {
        return captured.payloadBytes;
      },
      revert: () => {
        this.#model.replaceElements(captured.previous as readonly InkElementV1[]);
        effect?.revert();
      },
    });
  }

  public updatePage(previous: PageV1, replacement: PageV1): boolean {
    if (JSON.stringify(previous) === JSON.stringify(replacement)) return false;
    return this.#execute({
      apply: () => this.#model.commitPage(replacement),
      payloadBytes: new TextEncoder().encode(JSON.stringify([previous, replacement])).byteLength,
      revert: () => this.#model.commitPage(previous),
    });
  }

  public redo(): boolean {
    if (this.#model.mutationAvailability === "revision-exhausted") return false;
    return this.#history.redoSync();
  }

  public undo(): boolean {
    if (this.#model.mutationAvailability === "revision-exhausted") return false;
    return this.#history.undoSync();
  }

  public registerApplied(
    transition: AppliedAsyncHistoryTransition,
    effect?: SelectionFrameHistoryEffect,
  ): boolean {
    if (this.#disposed) return false;
    if (this.isTraversing) {
      throw new Error("Applied history cannot be registered during an Undo or Redo operation.");
    }
    effect?.apply();
    this.#history.registerApplied({
      get payloadBytes() {
        return transition.payloadBytes;
      },
      redo: () =>
        this.#replayAsync(
          () => transition.redo(),
          () => effect?.apply(),
        ),
      undo: () =>
        this.#replayAsync(
          () => transition.undo(),
          () => effect?.revert(),
        ),
    });
    this.#notifyCommitted();
    return true;
  }

  public registerAppliedReplacement(
    previous: readonly InkElementV1[],
    replacements: readonly InkElementV1[],
    transition: Omit<AppliedAsyncHistoryTransition, "payloadBytes">,
    effect?: SelectionFrameHistoryEffect,
  ): boolean {
    if (previous.length === 0 || previous.length !== replacements.length) return false;
    return this.registerApplied(
      {
        payloadBytes:
          estimateElementHistoryPayloadBytes(previous) +
          estimateElementHistoryPayloadBytes(replacements),
        redo: transition.redo,
        undo: transition.undo,
      },
      effect,
    );
  }

  public redoAsync(): Promise<boolean> {
    if (this.#model.mutationAvailability === "revision-exhausted") return Promise.resolve(false);
    return this.#traverse(() => this.#history.redo());
  }

  public subscribeCommitted(listener: CommitListener): () => void {
    this.#committedListeners.add(listener);
    return () => this.#committedListeners.delete(listener);
  }

  public undoAsync(): Promise<boolean> {
    if (this.#model.mutationAvailability === "revision-exhausted") return Promise.resolve(false);
    return this.#traverse(() => this.#history.undo());
  }

  public dispose(): void {
    this.#disposed = true;
    this.#committedListeners.clear();
    this.#history = new AppliedCommandHistory();
  }

  async #traverse(operation: () => Promise<boolean>): Promise<boolean> {
    if (this.#disposed) return false;
    const release = this.#model.beginInteractiveOperation?.();
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async #replayAsync(operation: () => Promise<boolean>, effect: () => void): Promise<boolean> {
    if (this.#disposed) return false;
    this.#replayDepth += 1;
    try {
      const applied = await operation();
      if (this.#disposed) return false;
      if (applied) effect();
      return applied;
    } finally {
      this.#replayDepth -= 1;
    }
  }

  #replaySync(operation: () => void): boolean {
    if (this.#disposed) return false;
    this.#replayDepth += 1;
    try {
      operation();
      return true;
    } finally {
      this.#replayDepth -= 1;
    }
  }

  #execute(mutation: SynchronousEditorMutation): boolean {
    if (this.#disposed) return false;
    if (this.isTraversing) {
      throw new Error("Editor history cannot commit during an Undo or Redo operation.");
    }
    if (this.#model.mutationAvailability === "revision-exhausted") return false;
    mutation.apply();
    this.#history.registerAppliedSync({
      payloadBytes: mutation.payloadBytes,
      redo: () => this.#replaySync(mutation.apply),
      undo: () => this.#replaySync(mutation.revert),
    });
    this.#notifyCommitted();
    return true;
  }

  #notifyCommitted(): void {
    for (const listener of this.#committedListeners) listener();
  }
}

export function captureElementReplacementHistory(
  previous: readonly InkElementV1[],
  replacements: readonly InkElementV1[],
) {
  let retainedPrevious: ElementReplacementHistoryData["previous"] = previous;
  let retainedReplacements: ElementReplacementHistoryData["replacements"] = replacements;
  let capturedPayload: number | undefined;
  return {
    capture: (history: ElementReplacementHistoryData) => {
      retainedPrevious = history.previous;
      retainedReplacements = history.replacements;
      capturedPayload = history.payloadBytes;
    },
    get previous() {
      return retainedPrevious;
    },
    get replacements() {
      return retainedReplacements;
    },
    get payloadBytes() {
      return (
        capturedPayload ??
        estimateElementHistoryPayloadBytes(retainedPrevious) +
          estimateElementHistoryPayloadBytes(retainedReplacements)
      );
    },
  };
}

function estimateElementHistoryPayloadBytes(
  elements: ElementReplacementHistoryData["previous"],
): number {
  return elements.reduce((total, element) => total + estimateElementPayloadBytes(element), 0);
}

function estimateElementPayloadBytes(
  element: ElementReplacementHistoryData["previous"][number],
): number {
  const structuralBytes = 256 + element.id.length * 2;
  switch (element.kind) {
    case "stroke":
      return structuralBytes + element.points.length * 8;
    case "coordinate-system":
      return structuralBytes + element.axes.length * 16;
    default:
      return structuralBytes;
  }
}

function sameBandOrder(left: ActiveEditorBandOrder, right: ActiveEditorBandOrder): boolean {
  for (const band of ["highlight", "content"] as const) {
    const leftOrder = left[band];
    const rightOrder = right[band];
    if (
      leftOrder.length !== rightOrder.length ||
      !leftOrder.every((id, index) => id === rightOrder[index])
    ) {
      return false;
    }
  }
  return true;
}

function estimateBandOrderPayloadBytes(
  previous: ActiveEditorBandOrder,
  replacement: ActiveEditorBandOrder,
): number {
  let bytes = 0;
  for (const order of [previous, replacement]) {
    for (const band of ["highlight", "content"] as const) {
      for (const id of order[band]) bytes += 8 + id.length * 2;
    }
  }
  return bytes;
}
