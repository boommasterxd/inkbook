import type { AppliedElementMutation } from "../../../domain/store/public";
import type { SelectionFrameHistoryEffect } from "../../../editor/selection/public";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import { applyDocumentHistoryMutation } from "./document-history";
import type { ActiveEditorHistory, AppliedAsyncHistoryTransition } from "./history";

interface PendingCreation {
  readonly id: string;
  readonly payloadBytes: number;
  readonly release: () => void;
}

/** An unused creation stays visible to input without becoming a saved history step. */
export class ProvisionalTextCreation {
  #pending: PendingCreation | undefined;

  public constructor(
    private readonly model: EditableDocumentModel,
    private readonly history: ActiveEditorHistory,
    private readonly lease: () => () => void,
    private readonly hasMeaningfulUserInput: () => boolean,
  ) {}

  public get pending(): boolean {
    return this.#pending !== undefined;
  }

  public get isDisposed(): boolean {
    return this.history.isDisposed;
  }

  public get isTraversing(): boolean {
    return this.history.isTraversing;
  }

  public begin(id: string, payloadBytes: number): void {
    this.release();
    this.#pending = { id, payloadBytes, release: this.lease() };
  }

  public registerApplied(transition: AppliedAsyncHistoryTransition): boolean {
    const pending = this.#pending;
    if (!pending) return this.history.registerApplied(transition);
    const element = this.model.store.get(pending.id)?.element;
    if (
      element?.kind !== "text" ||
      !this.hasMeaningfulUserInput() ||
      element.source.trim().length === 0
    )
      return true;
    const accepted = registerTextCreation(
      this.model,
      this.history,
      pending.id,
      pending.payloadBytes + transition.payloadBytes,
    );
    if (accepted) this.release();
    return accepted;
  }

  public registerGeometryApplied(
    transition: AppliedAsyncHistoryTransition,
    effect: SelectionFrameHistoryEffect | undefined,
    ids: readonly string[],
  ): boolean | undefined {
    if (ids.length !== 1 || this.#pending?.id !== ids[0]) return undefined;
    effect?.apply();
    return this.registerApplied(transition);
  }

  public async discard(currentVersion?: () => number): Promise<boolean> {
    const pending = this.#pending;
    if (!pending) return true;
    const version = currentVersion?.();
    const removed = await removeTextCreation(
      this.model,
      this.history,
      pending.id,
      () =>
        this.history.isTraversing || this.#pending !== pending || currentVersion?.() !== version,
    );
    if (removed === null && this.model.store.get(pending.id) !== undefined) return false;
    this.release();
    return true;
  }

  public release(): void {
    this.#pending?.release();
    this.#pending = undefined;
  }
}

function registerTextCreation(
  model: EditableDocumentModel,
  history: ActiveEditorHistory,
  id: string,
  payloadBytes: number,
): boolean {
  let removed: AppliedElementMutation | undefined;
  return history.registerApplied({
    payloadBytes,
    undo: async () => {
      if (removed)
        return applyDocumentHistoryMutation(
          model,
          removed.forward,
          removed,
          () => history.isDisposed,
        );
      const result = await removeTextCreation(model, history, id, () => false);
      if (result === null) return false;
      removed = result;
      return true;
    },
    redo: () =>
      removed
        ? applyDocumentHistoryMutation(model, removed.reverse, removed, () => history.isDisposed)
        : Promise.resolve(false),
  });
}

async function removeTextCreation(
  model: EditableDocumentModel,
  history: ActiveEditorHistory,
  id: string,
  isCancelled: () => boolean,
): Promise<AppliedElementMutation | null> {
  const revision = model.revision;
  const cancelled = () => isCancelled() || history.isDisposed || model.revision !== revision;
  try {
    const prepared = await model.prepareElementRemoval([id], { isCancelled: cancelled });
    if (prepared.status !== "prepared" || prepared.token === null || cancelled()) return null;
    return model.commitPreparedElementMutation(prepared.token);
  } catch {
    return null;
  }
}
