import { CommandHistory, type HistoryCommand } from "../../../domain/commands/history";
import type { ElementMutation } from "../../../domain/store/public";
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

  public async remove(
    ids: readonly string[],
    isCurrent: () => boolean = () => true,
  ): Promise<DocumentMutationOutcome> {
    if (this.#pending || this.#history.isTraversing) return "busy";
    const removed = new Set(ids.filter((id) => this.#model.store.get(id) !== undefined));
    if (removed.size === 0) return "noop";
    const generation = ++this.#generation;
    const basisRevision = this.#model.revision;
    const mutation: ElementMutation = {
      bands: {
        content: withoutIds(this.#model.store.materializeBandOrder("content"), removed),
        highlight: withoutIds(this.#model.store.materializeBandOrder("highlight"), removed),
      },
      removeIds: [...removed],
    };
    this.#setPending(true);
    try {
      const prepared = await this.#model.prepareElementMutation(mutation, {
        isCancelled: () =>
          !this.#isCurrent(generation, basisRevision) || this.#history.isTraversing || !isCurrent(),
      });
      if (prepared.status === "noop") return "noop";
      if (prepared.status !== "prepared" || prepared.token === null) return "stale";
      if (
        !this.#isCurrent(generation, basisRevision) ||
        this.#history.isTraversing ||
        !isCurrent()
      ) {
        return "stale";
      }
      const applied = this.#model.commitPreparedElementMutation(prepared.token);
      if (applied === null) return "stale";
      this.#history.registerApplied({
        payloadBytes: applied.payloadBytes,
        redo: () => this.#apply(applied.forward),
        undo: () => this.#apply(applied.reverse),
      });
      return "applied";
    } catch {
      return "failed";
    } finally {
      if (generation === this.#generation) this.#setPending(false);
    }
  }

  async #apply(mutation: ElementMutation): Promise<boolean> {
    if (this.#disposed) return false;
    const basisRevision = this.#model.revision;
    try {
      const prepared = await this.#model.prepareElementMutation(mutation, {
        isCancelled: () => this.#disposed || this.#model.revision !== basisRevision,
      });
      if (prepared.status !== "prepared" || prepared.token === null) return false;
      if (this.#disposed || this.#model.revision !== basisRevision) return false;
      return this.#model.commitPreparedElementMutation(prepared.token) !== null;
    } catch {
      return false;
    }
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

function withoutIds(ids: readonly string[], removed: ReadonlySet<string>): readonly string[] {
  return ids.filter((id) => !removed.has(id));
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
