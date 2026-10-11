import { CommandHistory, type HistoryCommand } from "../../../domain/commands/history";
import type {
  AppliedElementMutation,
  ElementMutation,
  PreparedElementMutationResult,
} from "../../../domain/store/public";
import { arrangeRenderBandSteps, type ArrangeAction } from "../../../domain/commands/arrange";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { ElementStore } from "../../../domain/store/public";
import type { TransformSliceScheduler } from "../../../editor/selection/transforms";
import type { EditableDocumentModel } from "../document-model-port";

import type { ActiveEditorHistory } from "./history";

export type DocumentMutationOutcome = "applied" | "busy" | "failed" | "noop" | "stale";

export interface ActiveDocumentHistoryOptions {
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly onPendingChanged?: (pending: boolean) => void;
}

export class ActiveDocumentHistory {
  readonly #history: ActiveEditorHistory;
  readonly #model: EditableDocumentModel;
  readonly #onPendingChanged: (pending: boolean) => void;
  #disposed = false;
  #generation = 0;
  #pending = false;

  public constructor(options: ActiveDocumentHistoryOptions) {
    this.#history = options.history;
    this.#model = options.model;
    this.#onPendingChanged = options.onPendingChanged ?? (() => undefined);
  }

  public get pending(): boolean {
    return this.#pending;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#setPending(false);
  }

  public remove(
    ids: readonly string[],
    isCurrent: () => boolean = () => true,
  ): Promise<DocumentMutationOutcome> {
    if (ids.length === 0) return Promise.resolve("noop");
    return this.#run(
      (isCancelled) => this.#model.prepareElementRemoval(ids, { isCancelled }),
      isCurrent,
    );
  }

  public arrange(
    action: ArrangeAction,
    selection: ReadonlySet<string>,
    scheduler: WorkScheduler,
    isCurrent: () => boolean,
  ): Promise<DocumentMutationOutcome> {
    return this.#run(async (isCancelled) => {
      const mutation = await this.#prepareArrange(action, selection, scheduler, isCancelled);
      if (mutation === "cancelled") return { status: "cancelled", token: null };
      if (mutation === null) return { status: "noop", token: null };
      return this.#model.prepareElementMutation(mutation, { isCancelled });
    }, isCurrent);
  }

  public removeSelection(
    selection: ReadonlySet<string>,
    scheduler: WorkScheduler,
    isCurrent: () => boolean,
    onCollected: (ids: readonly string[]) => void,
  ): Promise<DocumentMutationOutcome> {
    return this.#run(
      (isCancelled) => this.#prepareRemoval(selection, scheduler, isCancelled, onCollected),
      isCurrent,
    );
  }

  public removeAll(
    scheduler: WorkScheduler,
    isCurrent: () => boolean,
  ): Promise<DocumentMutationOutcome> {
    return this.#run(async (isCancelled) => {
      const bands = await this.#collectBandOrder(scheduler, isCancelled);
      if (bands === "cancelled") return { status: "cancelled", token: null };
      const ids = (function* () {
        yield* bands.highlight;
        yield* bands.content;
      })();
      return this.#prepareRemoval(ids, scheduler, isCancelled);
    }, isCurrent);
  }

  async #prepareRemoval(
    source: Iterable<string>,
    scheduler: WorkScheduler,
    isCancelled: () => boolean,
    onCollected?: (ids: readonly string[]) => void,
  ): Promise<PreparedElementMutationResult> {
    const ids: string[] = [];
    for (const id of source) {
      const wait = scheduler.checkpoint(undefined, "frame");
      if (wait !== undefined) await wait;
      if (isCancelled()) return { status: "cancelled", token: null };
      if (this.#model.store.get(id) !== undefined) ids.push(id);
    }
    if (isCancelled()) return { status: "cancelled", token: null };
    if (ids.length === 0) return { status: "noop", token: null };
    onCollected?.(ids);
    return this.#model.prepareElementRemoval(ids, { isCancelled });
  }

  #collectBandOrder(scheduler: WorkScheduler, isCancelled: () => boolean) {
    return collectDocumentBandOrder(this.#model.store, {
      isCancelled,
      shouldYield: () => scheduler.shouldYield(),
      yieldControl: () => scheduler.checkpoint(undefined, "frame") ?? Promise.resolve(),
    });
  }

  async #prepareArrange(
    action: ArrangeAction,
    selection: ReadonlySet<string>,
    scheduler: WorkScheduler,
    isCancelled: () => boolean,
  ): Promise<ElementMutation | "cancelled" | null> {
    const bands = await this.#collectBandOrder(scheduler, isCancelled);
    if (bands === "cancelled") return bands;
    let changed = false;
    for (const band of ["highlight", "content"] as const) {
      const steps = arrangeRenderBandSteps(bands[band], (id) => selection.has(id), action);
      while (!isCancelled()) {
        const wait = scheduler.checkpoint(undefined, "frame");
        if (wait !== undefined) await wait;
        if (isCancelled()) return "cancelled";
        const step = steps.next();
        if (!step.done) continue;
        changed ||= step.value.changed;
        bands[band] = step.value.elements as string[];
        break;
      }
    }
    if (isCancelled()) return "cancelled";
    return changed ? { bands } : null;
  }

  async #run(
    prepare: (isCancelled: () => boolean) => Promise<PreparedElementMutationResult>,
    isCurrent: () => boolean,
  ): Promise<DocumentMutationOutcome> {
    if (this.#pending || this.#history.isTraversing || this.#disposed) return "busy";
    const generation = ++this.#generation;
    const basisRevision = this.#model.revision;
    const release = this.#model.beginInteractiveOperation?.();
    const isCancelled = () =>
      !this.#isCurrent(generation, basisRevision) || this.#history.isTraversing || !isCurrent();
    this.#setPending(true);
    try {
      const prepared = await prepare(isCancelled);
      if (prepared.status === "noop") return "noop";
      if (prepared.status !== "prepared" || prepared.token === null) return "stale";
      if (isCancelled()) return "stale";
      const applied = this.#model.commitPreparedElementMutation(prepared.token);
      if (applied === null) return "stale";
      this.#history.registerApplied({
        payloadBytes: applied.payloadBytes,
        redo: () => this.#apply(applied.forward, applied),
        undo: () => this.#apply(applied.reverse, applied),
      });
      return "applied";
    } catch {
      return "failed";
    } finally {
      release?.();
      if (generation === this.#generation) this.#setPending(false);
    }
  }

  async #apply(mutation: ElementMutation, replay: AppliedElementMutation): Promise<boolean> {
    return applyDocumentHistoryMutation(this.#model, mutation, replay, () => this.#disposed);
  }

  #isCurrent(generation: number, basisRevision: number): boolean {
    return (
      !this.#disposed && generation === this.#generation && this.#model.revision === basisRevision
    );
  }

  #setPending(pending: boolean): void {
    if (pending === this.#pending) return;
    this.#pending = pending;
    this.#onPendingChanged(pending);
  }
}

export async function collectDocumentBandOrder(
  store: ElementStore,
  scheduler: TransformSliceScheduler,
): Promise<{ content: string[]; highlight: string[] } | "cancelled"> {
  const bands = { content: [] as string[], highlight: [] as string[] };
  const cursor = store.beginOrder();
  try {
    while (!scheduler.isCancelled?.()) {
      if (scheduler.shouldYield()) {
        await scheduler.yieldControl();
        if (scheduler.isCancelled?.()) return "cancelled";
      }
      const step = cursor.advance();
      if (step.stale) return "cancelled";
      if (step.done) return bands;
      const rank = store.getRank(step.id!);
      if (rank === undefined) return "cancelled";
      bands[rank.band].push(step.id!);
    }
    return "cancelled";
  } finally {
    cursor.cancel();
  }
}

export async function applyDocumentHistoryMutation(
  model: EditableDocumentModel,
  mutation: ElementMutation,
  replay: AppliedElementMutation,
  isCancelled: () => boolean,
): Promise<boolean> {
  const basisRevision = model.revision;
  const cancelled = () => isCancelled() || model.revision !== basisRevision;
  if (cancelled()) return false;
  try {
    const prepared = await model.prepareElementMutation(mutation, {
      replay,
      isCancelled: cancelled,
    });
    if (prepared.status !== "prepared" || prepared.token === null || cancelled()) return false;
    return model.commitPreparedElementMutation(prepared.token) !== null;
  } catch {
    return false;
  }
}

export type UnifiedHistoryDirection = "redo" | "undo";
export type UnifiedHistorySource = "canvas" | "markdown";

export type CanvasHistoryTraversalOutcome =
  | { readonly status: "applied"; readonly source: "canvas" }
  | { readonly status: "failed"; readonly source: "canvas" };

export type UnifiedHistoryShortcutOutcome =
  | { readonly completion: Promise<CanvasHistoryTraversalOutcome>; readonly status: "canvas" }
  | { readonly message: typeof UNIFIED_HISTORY_LOCK_NOTICE; readonly status: "lock-notice" }
  | { readonly status: "pass-through"; readonly source: "markdown" | "locked" };

export const UNIFIED_HISTORY_LOCK_NOTICE =
  "The embed must be locked to continue undoing in Obsidian.";

export interface CanvasHistoryPort {
  redo(): Promise<boolean>;
  undo(): Promise<boolean>;
}

interface UnifiedHistoryState {
  readonly source?: UnifiedHistorySource;
}

const UNIFIED_MARKER_BYTES = 16;

export class PaneDocumentHistoryAdapter {
  readonly #canvas: CanvasHistoryPort;
  readonly #history = new CommandHistory<UnifiedHistoryState>();
  #pending = false;
  #markdownSuppressionGeneration = 0;
  #suppressNextMarkdownMarker = false;
  #state: UnifiedHistoryState = {};

  public constructor(canvas: CanvasHistoryPort) {
    this.#canvas = canvas;
  }

  public get pending(): boolean {
    return this.#pending;
  }

  public clear(): void {
    if (this.#pending) return;
    this.#history.clear();
    this.#state = {};
  }

  public record(source: UnifiedHistorySource): boolean {
    if (this.#pending) throw new Error("Unified history cannot record during traversal.");
    if (source === "markdown" && this.#suppressNextMarkdownMarker) {
      this.#suppressNextMarkdownMarker = false;
      this.#markdownSuppressionGeneration += 1;
      return false;
    }
    const transition = this.#history.execute(this.#state, sourceMarker(source));
    this.#state = transition.state;
    return true;
  }

  public handleShortcut(
    direction: UnifiedHistoryDirection,
    canvasLocked: boolean,
  ): UnifiedHistoryShortcutOutcome {
    if (canvasLocked) return { status: "pass-through", source: "locked" };
    if (this.#pending) {
      return {
        completion: Promise.resolve({ status: "failed", source: "canvas" }),
        status: "canvas",
      };
    }
    const transition = this.#transition(direction);
    if (!transition.changed || transition.state.source === undefined) {
      return { message: UNIFIED_HISTORY_LOCK_NOTICE, status: "lock-notice" };
    }
    if (transition.state.source === "markdown") {
      this.#state = transition.state;
      this.#armMarkdownMarkerSuppression();
      return { status: "pass-through", source: "markdown" };
    }
    return { completion: this.#traverseCanvas(direction, transition.state), status: "canvas" };
  }

  async #traverseCanvas(
    direction: UnifiedHistoryDirection,
    state: UnifiedHistoryState,
  ): Promise<CanvasHistoryTraversalOutcome> {
    this.#pending = true;
    try {
      const changed = await this.#canvas[direction]();
      if (!changed) {
        this.#restoreCursor(direction);
        return { status: "failed", source: "canvas" };
      }
      this.#state = state;
      return { status: "applied", source: "canvas" };
    } catch {
      this.#restoreCursor(direction);
      return { status: "failed", source: "canvas" };
    } finally {
      this.#pending = false;
    }
  }

  #transition(direction: UnifiedHistoryDirection) {
    return direction === "undo" ? this.#history.undo(this.#state) : this.#history.redo(this.#state);
  }

  #restoreCursor(direction: UnifiedHistoryDirection): void {
    const restored =
      direction === "undo" ? this.#history.redo(this.#state) : this.#history.undo(this.#state);
    if (!restored.changed) throw new Error("Unified history cursor could not be restored.");
    this.#state = restored.state;
  }

  #armMarkdownMarkerSuppression(): void {
    this.#suppressNextMarkdownMarker = true;
    this.#markdownSuppressionGeneration += 1;
    const generation = this.#markdownSuppressionGeneration;
    queueMicrotask(() => {
      if (generation === this.#markdownSuppressionGeneration) {
        this.#suppressNextMarkdownMarker = false;
      }
    });
  }
}

function sourceMarker(source: UnifiedHistorySource): HistoryCommand<UnifiedHistoryState> {
  return {
    payloadBytes: UNIFIED_MARKER_BYTES,
    apply: () => ({ source }),
    revert: () => ({ source }),
  };
}
