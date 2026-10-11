import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import {
  moveSelectionTimeSliced,
  type SelectionHandleSession,
} from "../../../editor/selection/public";
import type { TransformSliceScheduler } from "../../../editor/selection/transforms";
import type { EditableDocumentModel } from "../vault-document-session";
import type { SelectionFrameHistoryEffect } from "../../../editor/selection/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

import type { ActiveEditorHistory } from "./history";
import { createSelectionStyleReplacementSteps } from "./controller-styles";
import { applyDocumentHistoryMutation, collectDocumentBandOrder } from "./document-history";

const SYNCHRONOUS_SELECTION_LIMIT = 1_000;
export interface PreparedElementHistoryOptions {
  readonly history: ActiveEditorHistory;
  readonly isAttached: () => boolean;
  readonly model: EditableDocumentModel;
  readonly motion: {
    beginPreviewCommit(): {
      arm(ids: readonly string[]): boolean;
      cancel(): void;
    };
  };
  readonly onPendingChanged: (pending: boolean) => void;
  readonly workScheduler: WorkScheduler;
}

type SelectionFrameEffectFactory = (
  replacements: readonly InkElementV1[],
) => SelectionFrameHistoryEffect | undefined;

export interface PreparedStyleChange {
  readonly selection: ReadonlySet<string>;
  readonly controlId: string;
  readonly value: boolean | number | string;
  readonly isCurrent: () => boolean;
  readonly frameEffect?: (
    previous: readonly InkElementV1[],
    replacements: readonly InkElementV1[],
    scheduler: TransformSliceScheduler,
  ) => Promise<SelectionFrameHistoryEffect | undefined>;
  readonly onCompleted: (committed: boolean) => void;
}

export class PreparedElementHistory {
  readonly #history: ActiveEditorHistory;
  readonly #isAttached: () => boolean;
  readonly #model: EditableDocumentModel;
  readonly #motion: PreparedElementHistoryOptions["motion"];
  readonly #onPendingChanged: (pending: boolean) => void;
  readonly #workScheduler: WorkScheduler;
  readonly #abort = new AbortController();
  #disposed = false;
  #generation = 0;
  #pending = false;

  public constructor(options: PreparedElementHistoryOptions) {
    this.#history = options.history;
    this.#isAttached = options.isAttached;
    this.#model = options.model;
    this.#motion = options.motion;
    this.#onPendingChanged = options.onPendingChanged;
    this.#workScheduler = options.workScheduler;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#abort.abort();
    this.#setPending(false);
  }

  public cancel(): void {
    this.#generation += 1;
  }

  public commitStyle(change: PreparedStyleChange): boolean {
    if (this.#pending || this.#disposed || this.#history.isTraversing) return false;
    const basisRevision = this.#model.revision;
    this.#run(async (generation) => {
      const scheduler = this.#scheduler(generation);
      const isCancelled = scheduler.isCancelled;
      const styleScheduler = {
        ...scheduler,
        isCancelled: () =>
          isCancelled?.() === true ||
          this.#history.isTraversing ||
          !change.isCurrent() ||
          this.#model.revision !== basisRevision,
      };
      const selected = this.#selectedElements(change.selection);
      const steps = createSelectionStyleReplacementSteps(selected, change.controlId, change.value);
      let step: ReturnType<typeof steps.next>;
      do {
        if (styleScheduler.isCancelled()) return false;
        if (styleScheduler.shouldYield()) {
          await styleScheduler.yieldControl();
          if (styleScheduler.isCancelled()) return false;
        }
        step = steps.next();
      } while (!step.done);
      if (step.value === null) return false;
      const plan = await this.#model.store.planReplacementsTimeSliced(
        step.value.replacements,
        styleScheduler,
      );
      if (plan === null || plan === "cancelled") return false;
      const effect = await change.frameEffect?.(
        step.value.previous,
        step.value.replacements,
        styleScheduler,
      );
      if (styleScheduler.isCancelled()) return false;
      return this.#commitStyleApplied(plan.elements, styleScheduler, effect);
    }, change.onCompleted);
    return true;
  }

  *#selectedElements(selection: ReadonlySet<string>): Generator<InkElementV1> {
    for (const id of selection) {
      const record = this.#model.store.get(id);
      if (record === undefined) throw new RangeError("Style selection is stale.");
      yield record.element as InkElementV1;
    }
  }

  async #commitStyleApplied(
    replacements: readonly InkElementV1[],
    scheduler: TransformSliceScheduler,
    effect?: SelectionFrameHistoryEffect,
  ): Promise<boolean> {
    const bands = await collectDocumentBandOrder(this.#model.store, scheduler);
    if (bands === "cancelled") return false;
    const prepared = await this.#model.prepareElementMutation(
      { bands, elements: replacements },
      {
        isCancelled: () => scheduler.isCancelled?.() ?? false,
      },
    );
    if (prepared.status !== "prepared" || prepared.token === null || scheduler.isCancelled?.())
      return false;
    const applied = this.#model.commitPreparedElementMutation(prepared.token);
    if (applied === null) return false;
    const replay = (mutation: typeof applied.forward) =>
      applyDocumentHistoryMutation(
        this.#model,
        mutation,
        applied,
        () => this.#disposed || !this.#isAttached(),
      );
    this.#history.registerApplied(
      {
        payloadBytes: applied.payloadBytes,
        redo: () => replay(applied.forward),
        undo: () => replay(applied.reverse),
      },
      effect,
    );
    return true;
  }

  public commitHandle(
    session: SelectionHandleSession,
    onCompleted?: (committed: boolean) => void,
    frameEffect?: SelectionFrameEffectFactory,
  ): boolean {
    if (this.#pending || this.#disposed) return false;
    const previewCommit = this.#motion.beginPreviewCommit();
    this.#run(async (generation) => {
      try {
        const prepared = await session.prepareCommitTimeSliced(this.#scheduler(generation));
        if (prepared.status !== "ready") return false;
        const effect = frameEffect?.(prepared.replacements);
        return await this.#commitApplied(
          prepared.previous,
          prepared.replacements,
          generation,
          previewCommit,
          effect,
        );
      } finally {
        previewCommit.cancel();
      }
    }, onCompleted);
    return true;
  }

  public commitMove(
    elements: readonly InkElementV1[],
    delta: PointV1,
    onCompleted?: (committed: boolean) => void,
    effect?: SelectionFrameHistoryEffect,
  ): boolean {
    if (!requiresSlicedMove(elements) || this.#pending || this.#disposed) {
      return false;
    }
    const previewCommit = this.#motion.beginPreviewCommit();
    this.#run(async (generation) => {
      try {
        const scheduler = this.#scheduler(generation);
        const replacements = await moveSelectionTimeSliced(elements, delta, scheduler);
        if (replacements === null) return false;
        return await this.#commitApplied(elements, replacements, generation, previewCommit, effect);
      } finally {
        previewCommit.cancel();
      }
    }, onCompleted);
    return true;
  }

  async #commitApplied(
    previous: readonly InkElementV1[],
    replacements: readonly InkElementV1[],
    generation: number,
    previewCommit: ReturnType<PreparedElementHistoryOptions["motion"]["beginPreviewCommit"]>,
    effect?: SelectionFrameHistoryEffect,
  ): Promise<boolean> {
    const committed = await this.#replace(
      replacements,
      generation,
      previous.map(({ id }) => id),
      previewCommit,
    );
    if (!committed) return false;
    this.#registerApplied(previous, replacements, effect);
    return true;
  }

  #registerApplied(
    previous: readonly InkElementV1[],
    replacements: readonly InkElementV1[],
    effect?: SelectionFrameHistoryEffect,
  ): void {
    this.#history.registerAppliedReplacement(
      previous,
      replacements,
      {
        redo: () => this.#replace(replacements, this.#generation),
        undo: () => this.#replace(previous, this.#generation),
      },
      effect,
    );
  }

  async #replace(
    elements: readonly InkElementV1[],
    generation: number,
    suppressMotionIds?: readonly string[],
    previewCommit?: ReturnType<PreparedElementHistoryOptions["motion"]["beginPreviewCommit"]>,
  ): Promise<boolean> {
    const basisRevision = this.#model.revision;
    const cancellation = {
      isCancelled: () => this.#isCancelled(generation) || this.#model.revision !== basisRevision,
    };
    const preparation = await this.#model.prepareElementReplacement(elements, cancellation);
    if (preparation.status !== "prepared" || preparation.token === null) return false;
    if (cancellation.isCancelled()) return false;
    if (
      previewCommit !== undefined &&
      suppressMotionIds !== undefined &&
      !previewCommit.arm(suppressMotionIds)
    ) {
      return false;
    }
    return this.#model.commitPreparedElementReplacement(preparation.token) === "committed";
  }

  #run(
    operation: (generation: number) => Promise<boolean>,
    onCompleted?: (committed: boolean) => void,
  ): void {
    const generation = ++this.#generation;
    const release = this.#model.beginInteractiveOperation?.();
    this.#setPending(true);
    void operation(generation)
      .catch(() => false)
      .finally(() => {
        release?.();
        this.#setPending(false);
      })
      .then((committed) => {
        if (!this.#disposed && generation === this.#generation) onCompleted?.(committed);
      });
  }

  #scheduler(generation: number): TransformSliceScheduler {
    return {
      isCancelled: () => this.#isCancelled(generation),
      shouldYield: () => this.#workScheduler.shouldYield(),
      yieldControl: () =>
        this.#workScheduler.checkpoint(this.#abort.signal, "frame") ?? Promise.resolve(),
    };
  }

  #isCancelled(generation: number): boolean {
    return this.#disposed || generation !== this.#generation || !this.#isAttached();
  }

  #setPending(pending: boolean): void {
    if (pending === this.#pending) return;
    this.#pending = pending;
    this.#onPendingChanged(pending);
  }
}

function requiresSlicedMove(elements: readonly InkElementV1[]): boolean {
  return elements.length > SYNCHRONOUS_SELECTION_LIMIT;
}
