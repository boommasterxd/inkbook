import type { InkElementV1 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { withElementLock } from "../../../domain/store/public";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import { captureElementReplacementHistory, type ActiveEditorHistory } from "./history";

export interface ElementLockSessionOptions {
  readonly model: EditableDocumentModel;
  readonly history: ActiveEditorHistory;
  readonly workScheduler: WorkScheduler;
  readonly currentSelection: () => ReadonlySet<string>;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly isEnabled: () => boolean;
  readonly isAttached: () => boolean;
  readonly finishText?: () => Promise<boolean>;
  readonly onPendingChanged: (pending: boolean) => void;
  readonly onStateChanged: () => void;
  readonly onFailed: () => void;
}

/** Lock commands retain individual previous states and never replace element geometry. */
export class ElementLockSession {
  readonly #options: ElementLockSessionOptions;
  readonly #abort = new AbortController();
  #disposed = false;
  #pending = false;
  #summary:
    | {
        revision: number;
        selection: ReadonlySet<string>;
        state: { unlocked: number; locked: number };
      }
    | undefined;

  public constructor(options: ElementLockSessionOptions) {
    this.#options = options;
  }

  public get pending(): boolean {
    return this.#pending;
  }

  public get selectionState(): { readonly unlocked: number; readonly locked: number } {
    const { model, currentSelection } = this.#options;
    const selection = currentSelection();
    if (this.#summary?.revision === model.revision && this.#summary.selection === selection)
      return this.#summary.state;
    let unlocked = 0;
    let locked = 0;
    for (const id of selection) {
      const element = model.store.get(id)?.element;
      if (element === undefined) continue;
      if (element.locked === true) locked += 1;
      else unlocked += 1;
    }
    this.#summary = { revision: model.revision, selection, state: { unlocked, locked } };
    return this.#summary.state;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#abort.abort();
    this.#summary = undefined;
  }

  public setLocked(locked: boolean): void {
    const selection = this.#options.currentSelection();
    void this.#run(async (isCancelled) => {
      const { model, history, currentSelection } = this.#options;
      if (currentSelection() !== selection) return;
      const previous: InkElementV1[] = [];
      const replacements: InkElementV1[] = [];
      for (const id of selection) {
        const wait = this.#options.workScheduler.checkpoint(this.#abort.signal, "frame");
        if (wait !== undefined) await wait;
        if (isCancelled()) return;
        const element = model.store.get(id)?.element;
        if (element === undefined || (element.locked === true) === locked) continue;
        previous.push(element as InkElementV1);
        replacements.push(withElementLock(element, locked));
      }
      if (replacements.length === 0 || isCancelled() || currentSelection() !== selection) return;
      const captured = captureElementReplacementHistory(previous, replacements);
      const cancelled = () => isCancelled() || currentSelection() !== selection;
      const prepared = await model.prepareElementReplacement(replacements, {
        isCancelled: cancelled,
        protectLocked: false,
      });
      if (prepared.status !== "prepared" || prepared.token === null || cancelled()) return;
      if (model.commitPreparedElementReplacement(prepared.token, captured.capture) !== "committed")
        return;
      history.registerApplied({
        get payloadBytes() {
          return captured.payloadBytes;
        },
        undo: () => this.#replay(captured.previous as readonly InkElementV1[]),
        redo: () => this.#replay(captured.replacements as readonly InkElementV1[]),
      });
      this.#options.onStateChanged();
    });
  }

  public selectLocked(): void {
    void this.#run(async (isCancelled) => {
      const { model, setSelection } = this.#options;
      const cursor = model.store.beginOrder();
      const selection = new Set<string>();
      try {
        while (!isCancelled()) {
          const wait = this.#options.workScheduler.checkpoint(this.#abort.signal, "frame");
          if (wait !== undefined) await wait;
          if (isCancelled()) return;
          const step = cursor.advance();
          if (step.stale) return;
          if (step.done) {
            setSelection(selection);
            return;
          }
          if (model.store.get(step.id!)?.element.locked === true) selection.add(step.id!);
        }
      } finally {
        cursor.cancel();
      }
    });
  }

  async #replay(elements: readonly InkElementV1[]): Promise<boolean> {
    const { model, history } = this.#options;
    const revision = model.revision;
    const isCancelled = () => history.isDisposed || model.revision !== revision;
    const prepared = await model.prepareElementReplacement(elements, {
      isCancelled,
      protectLocked: false,
    });
    return (
      prepared.status === "prepared" &&
      prepared.token !== null &&
      !isCancelled() &&
      model.commitPreparedElementReplacement(prepared.token) === "committed"
    );
  }

  async #run(operation: (isCancelled: () => boolean) => Promise<void>): Promise<void> {
    const options = this.#options;
    if (this.#pending || this.#disposed || !options.isEnabled() || options.history.isTraversing)
      return;
    this.#pending = true;
    try {
      if (options.finishText !== undefined && !(await options.finishText())) return;
      if (this.#disposed || !options.isAttached() || options.history.isTraversing) return;
      const revision = options.model.revision;
      const isCancelled = () =>
        this.#disposed ||
        !options.isAttached() ||
        options.history.isTraversing ||
        options.model.revision !== revision;
      options.onPendingChanged(true);
      const release = options.model.beginInteractiveOperation?.();
      try {
        await operation(isCancelled);
      } finally {
        release?.();
      }
    } catch {
      if (!this.#disposed && options.isAttached()) options.onFailed();
    } finally {
      this.#pending = false;
      if (!this.#disposed) options.onPendingChanged(false);
    }
  }
}
