import type { InkElementV1 } from "../../../domain/schema/public";
import type { AppliedElementMutation, ElementMutation } from "../../../domain/store/public";
import {
  EraserSweep,
  type EraserFeedbackPort,
  type GesturePreview,
  type GesturePreviewStart,
} from "../../../editor/gestures/public";
import type { EditableDocumentModel } from "../vault-document-session";

import { EraserFrameScheduler } from "./eraser-scheduler";
import { applyDocumentHistoryMutation } from "./document-history";
import type { ActiveEditorHistory } from "./history";
import type { ElementSceneStore } from "./scene-store";
import type { CoalescedCreationSample } from "./coalesced-input";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { TRANSITION_DURATIONS } from "../../../rendering/motion/transitions";

interface EraserPreviewRenderer {
  clearElementFade(ids: readonly string[]): void;
  setElementFade(ids: readonly string[], durationMs: number): void;
}

export interface EraserPreviewOptions {
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly workScheduler: WorkScheduler;
  readonly radius: number;
  readonly renderer: EraserPreviewRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly start: GesturePreviewStart;
}

export class EraserPreview implements GesturePreview {
  readonly #history: ActiveEditorHistory;
  readonly #model: EditableDocumentModel;
  readonly #workScheduler: WorkScheduler;
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
    this.#workScheduler = options.workScheduler;
    this.#sliceBudgetMs = () => this.#workScheduler.budgetMs();
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
      () => this.#workScheduler.shouldYield(),
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
      this.#workScheduler,
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
    this.#workFrame = this.#workScheduler.requestFrame(() => {
      this.#workFrame = null;
      if (this.#model.revision !== this.#expectedRevision) {
        this.#cancelPending();
        return;
      }
      if (this.#sweep.updateBatch([]) === "cancelled") this.#cancelled = true;
      this.#scheduleWork();
    }, "frame");
  }

  #cancelWorkFrame(): void {
    if (this.#workFrame === null) return;
    this.#workScheduler.cancelFrame(this.#workFrame);
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
    const prepared = await this.#model.prepareElementRemoval(ids, { isCancelled: cancelled });
    if (prepared.token === null || cancelled()) return false;
    const applied = this.#model.commitPreparedElementMutation(prepared.token);
    if (applied === null) return false;
    this.#history.registerApplied({
      payloadBytes: applied.payloadBytes,
      redo: () => this.#applyMutation(applied.forward, applied),
      undo: () => this.#applyMutation(applied.reverse, applied),
    });
    return true;
  }

  #applyMutation(mutation: ElementMutation, replay: AppliedElementMutation): Promise<boolean> {
    return applyDocumentHistoryMutation(this.#model, mutation, replay, () => false);
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
    addCandidateFade: (ids) => {
      renderer.setElementFade(ids, TRANSITION_DURATIONS.eraserPendingRemoval);
    },
    setCandidateFade: (ids) => {
      renderer.setElementFade([...ids], TRANSITION_DURATIONS.eraserPendingRemoval);
    },
  };
}
