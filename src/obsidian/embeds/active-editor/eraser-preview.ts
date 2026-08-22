import type { InkElementV1 } from "../../../domain/schema/public";
import type { ElementMutation } from "../../../domain/store/public";
import {
  EraserSweep,
  type EraserFeedbackPort,
  type GesturePreview,
  type GesturePreviewStart,
} from "../../../editor/gestures/public";
import type { EditableDocumentModel } from "../vault-document-session";

import { EraserFrameScheduler } from "./eraser-scheduler";
import type { ActiveEditorHistory } from "./history";
import type { ElementSceneStore } from "./scene-store";

interface EraserPreviewRenderer {
  clearElementFade(ids: readonly string[]): void;
  setElementFade(ids: readonly string[], durationMs: number): void;
}

export interface EraserPreviewOptions {
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly ownerWindow: Window;
  readonly radius: number;
  readonly renderer: EraserPreviewRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly start: GesturePreviewStart;
}

export class EraserPreview implements GesturePreview {
  readonly #history: ActiveEditorHistory;
  readonly #model: EditableDocumentModel;
  readonly #ownerWindow: Window;
  readonly #sweep: EraserSweep;
  #cancelled = false;
  #completion: Promise<boolean> | null = null;
  #finished = false;
  #generation = 0;
  #scheduler: EraserFrameScheduler | null = null;

  public constructor(options: EraserPreviewOptions) {
    this.#history = options.history;
    this.#model = options.model;
    this.#ownerWindow = options.ownerWindow;
    const feedback = createFeedback(options.renderer);
    this.#sweep = new EraserSweep(
      options.start.pointer,
      options.radius,
      {
        getElement: (id) => options.model.store.get(id)?.element as InkElementV1 | undefined,
        query: (bounds, sink) => options.sceneStore.query(bounds, sink),
      },
      feedback,
    );
  }

  public get completion(): Promise<boolean> {
    return this.#completion ?? Promise.resolve(false);
  }

  public commit(): boolean {
    this.#assertActive();
    this.#finished = true;
    if (this.#cancelled) return false;
    const generation = ++this.#generation;
    const scheduler = new EraserFrameScheduler(this.#ownerWindow);
    this.#scheduler = scheduler;
    this.#completion = this.#sweep
      .commit((ids) => this.#remove(ids, generation, scheduler), scheduler)
      .catch(() => false)
      .finally(() => {
        if (generation === this.#generation) this.#scheduler = null;
      });
    return true;
  }

  public revert(): void {
    if (this.#finished && this.#scheduler === null) return;
    this.#finished = true;
    this.#cancelled = true;
    this.#generation += 1;
    this.#scheduler?.cancel();
    this.#scheduler = null;
    this.#sweep.revert();
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.#assertActive();
    if (this.#sweep.update(pointer) === "cancelled") this.#cancelled = true;
  }

  async #remove(
    ids: ReadonlySet<string>,
    generation: number,
    scheduler: EraserFrameScheduler,
  ): Promise<boolean> {
    const expectedRevision = this.#model.revision;
    const cancelled = () =>
      scheduler.isCancelled() ||
      generation !== this.#generation ||
      this.#model.revision !== expectedRevision;
    const mutation = await this.#removalMutation(ids, scheduler, cancelled);
    if (mutation === null || cancelled()) return false;
    const prepared = await this.#model.prepareElementMutation(mutation, {
      isCancelled: cancelled,
    });
    if (prepared.token === null || cancelled()) return false;
    const applied = this.#model.commitPreparedElementMutation(prepared.token);
    if (applied === null) return false;
    this.#history.registerApplied({
      payloadBytes: applied.payloadBytes,
      redo: () => this.#applyMutation(applied.forward),
      undo: () => this.#applyMutation(applied.reverse),
    });
    return true;
  }

  async #removalMutation(
    ids: ReadonlySet<string>,
    scheduler: EraserFrameScheduler,
    cancelled: () => boolean,
  ): Promise<ElementMutation | null> {
    const removeIds: string[] = [];
    for (const id of ids) {
      if (cancelled()) return null;
      removeIds.push(id);
      if (scheduler.shouldYield()) await scheduler.yieldControl();
    }
    const content = await this.#filterBand("content", ids, scheduler, cancelled);
    if (content === null) return null;
    const highlight = await this.#filterBand("highlight", ids, scheduler, cancelled);
    if (highlight === null) return null;
    return { bands: { content, highlight }, removeIds };
  }

  async #filterBand(
    band: "content" | "highlight",
    removed: ReadonlySet<string>,
    scheduler: EraserFrameScheduler,
    cancelled: () => boolean,
  ): Promise<string[] | null> {
    const kept: string[] = [];
    for (const id of this.#model.store.materializeBandOrder(band)) {
      if (cancelled()) return null;
      if (!removed.has(id)) kept.push(id);
      if (scheduler.shouldYield()) await scheduler.yieldControl();
    }
    return kept;
  }

  async #applyMutation(mutation: ElementMutation): Promise<boolean> {
    const expectedRevision = this.#model.revision;
    const cancelled = () => this.#model.revision !== expectedRevision;
    const prepared = await this.#model.prepareElementMutation(mutation, {
      isCancelled: cancelled,
    });
    if (prepared.token === null || cancelled()) return false;
    return this.#model.commitPreparedElementMutation(prepared.token) !== null;
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed eraser preview cannot be updated.");
  }
}

function createFeedback(renderer: EraserPreviewRenderer): EraserFeedbackPort {
  return {
    clearCandidateFade: (ids) => {
      renderer.clearElementFade([...ids]);
    },
    addCandidateFade: (ids, durationMs) => {
      renderer.setElementFade(ids, durationMs);
    },
    setCandidateFade: (ids, durationMs) => {
      renderer.setElementFade([...ids], durationMs);
    },
  };
}
