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
import type { CoalescedCreationSample } from "./coalesced-input";

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
  readonly sliceBudgetMs?: () => number;
  readonly start: GesturePreviewStart;
}

export class EraserPreview implements GesturePreview {
  readonly #history: ActiveEditorHistory;
  readonly #model: EditableDocumentModel;
  readonly #ownerWindow: Window;
  readonly #sweep: EraserSweep;
  readonly #sliceBudgetMs: () => number;
  readonly #expectedRevision: number;
  #workFrame: number | null = null;
  #cancelled = false;
  #completion: Promise<boolean> | null = null;
  #finished = false;
  #generation = 0;
  #scheduler: EraserFrameScheduler | null = null;

  public constructor(options: EraserPreviewOptions) {
    this.#history = options.history;
    this.#model = options.model;
    this.#expectedRevision = options.model.revision;
    this.#ownerWindow = options.ownerWindow;
    this.#sliceBudgetMs = options.sliceBudgetMs ?? (() => 8);
    const feedback = createFeedback(options.renderer);
    this.#sweep = new EraserSweep(
      options.start.pointer,
      options.radius,
      {
        getElement: (id) => options.model.store.get(id)?.element as InkElementV1 | undefined,
        beginQuery: (bounds) => options.sceneStore.beginQuery(bounds),
      },
      feedback,
      this.#sliceBudgetMs,
    );
    this.#scheduleWork();
  }

  public get completion(): Promise<boolean> {
    return this.#completion ?? Promise.resolve(false);
  }

  public commit(): boolean {
    this.#assertActive();
    this.#cancelWorkFrame();
    if (this.#model.revision !== this.#expectedRevision) this.#cancelPending();
    this.#finished = true;
    if (this.#cancelled) return false;
    const generation = ++this.#generation;
    const scheduler = new EraserFrameScheduler(
      this.#ownerWindow,
      this.#sliceBudgetMs,
      () => this.#model.revision !== this.#expectedRevision,
    );
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
    this.#cancelWorkFrame();
    this.#scheduler?.cancel();
    this.#scheduler = null;
    this.#sweep.revert();
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.updateSamples([{ ...pointer, time: 0 }]);
  }

  public updateSamples(samples: readonly CoalescedCreationSample[]): void {
    this.#assertActive();
    if (this.#model.revision !== this.#expectedRevision) {
      this.#cancelPending();
      return;
    }
    if (this.#sweep.enqueueBatch(samples) === "cancelled") {
      this.#cancelled = true;
      this.#cancelWorkFrame();
    }
    this.#scheduleWork();
  }

  #cancelPending(): void {
    this.#cancelled = true;
    this.#cancelWorkFrame();
    this.#sweep.revert();
  }

  #scheduleWork(): void {
    if (
      this.#cancelled ||
      this.#finished ||
      this.#workFrame !== null ||
      this.#sweep.retainedSweepCount === 0
    )
      return;
    this.#workFrame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#workFrame = null;
      if (this.#model.revision !== this.#expectedRevision) {
        this.#cancelPending();
        return;
      }
      if (this.#sweep.updateBatch([]) === "cancelled") this.#cancelled = true;
      this.#scheduleWork();
    });
  }

  #cancelWorkFrame(): void {
    if (this.#workFrame === null) return;
    this.#ownerWindow.cancelAnimationFrame(this.#workFrame);
    this.#workFrame = null;
  }

  async #remove(
    ids: ReadonlySet<string>,
    generation: number,
    scheduler: EraserFrameScheduler,
  ): Promise<boolean> {
    const expectedRevision = this.#expectedRevision;
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
    return { removeIds };
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
