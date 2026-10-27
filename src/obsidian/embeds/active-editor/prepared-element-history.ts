import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import {
  moveSelectionTimeSliced,
  moveSelectionWithSnap,
  type SelectionHandleSession,
  type SelectionMoveSnap,
} from "../../../editor/selection/public";
import { hasLinearConnectionDependencies } from "../../../editor/selection/selection-work-budget";
import type { TransformSliceScheduler } from "../../../editor/selection/transform/transforms";
import type { EditableDocumentModel } from "../document-session/vault-document-session";
import type { SelectionFrameHistoryEffect } from "../../../editor/selection/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { ElementReplacementHistoryData } from "../../../domain/store/public";
import { DEFAULT_HISTORY_BYTE_LIMIT } from "../../../domain/commands/history";

import { captureElementReplacementHistory, type ActiveEditorHistory } from "./history";
import { createSelectionStyleReplacementSteps } from "./controller-styles";

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
  scheduler: TransformSliceScheduler,
) => SelectionFrameHistoryEffect | undefined | Promise<SelectionFrameHistoryEffect | undefined>;

interface ReplacementCommitConditions {
  readonly isCancelled?: () => boolean;
  readonly maxHistoryPayloadBytes?: number;
}

interface PreparedMovePreview {
  readonly onSettled: () => void;
  readonly requiresPreparation: boolean;
  readonly prepareSnap?: () => Promise<
    | {
        readonly delta: PointV1;
        readonly snap: SelectionMoveSnap | null;
        readonly effect?: SelectionFrameHistoryEffect;
      }
    | "cancelled"
  >;
}

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
      const effect = await change.frameEffect?.(
        step.value.previous,
        step.value.replacements,
        styleScheduler,
      );
      if (styleScheduler.isCancelled()) return false;
      return this.#commitApplied(
        step.value.previous,
        step.value.replacements,
        generation,
        undefined,
        effect,
        {
          isCancelled: styleScheduler.isCancelled,
          maxHistoryPayloadBytes: DEFAULT_HISTORY_BYTE_LIMIT,
        },
      );
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

  public commitHandle(
    session: SelectionHandleSession,
    onCompleted?: (committed: boolean) => void,
    frameEffect?: SelectionFrameEffectFactory,
    onSettled?: () => void,
  ): boolean {
    if (this.#pending || this.#disposed) return false;
    const previewCommit = this.#motion.beginPreviewCommit();
    this.#run(
      async (generation) => {
        try {
          const basisRevision = this.#model.revision;
          const sessionGeneration = session.generation;
          const scheduler = this.#scheduler(generation);
          const handleScheduler = {
            ...scheduler,
            isCancelled: () =>
              scheduler.isCancelled?.() === true ||
              this.#history.isTraversing ||
              this.#model.revision !== basisRevision ||
              session.generation !== sessionGeneration,
          };
          const prepared = await session.prepareCommitTimeSliced(handleScheduler);
          if (prepared.status !== "ready" || handleScheduler.isCancelled()) return false;
          const effect = await frameEffect?.(prepared.replacements, handleScheduler);
          if (handleScheduler.isCancelled()) return false;
          return await this.#commitApplied(
            prepared.previous,
            prepared.replacements,
            generation,
            previewCommit,
            effect,
            { isCancelled: handleScheduler.isCancelled },
          );
        } finally {
          previewCommit.cancel();
        }
      },
      onCompleted,
      onSettled,
    );
    return true;
  }

  public commitMove(
    elements: readonly InkElementV1[],
    delta: PointV1,
    onCompleted?: (committed: boolean) => void,
    effect?: SelectionFrameHistoryEffect,
    snap: SelectionMoveSnap | null = null,
    preview?: PreparedMovePreview,
  ): boolean {
    if (
      (!preview?.requiresPreparation && !requiresSlicedMove(elements, snap)) ||
      this.#pending ||
      this.#disposed
    ) {
      return false;
    }
    if (snap !== null && elements.length !== 1) {
      throw new RangeError("Snapped movement requires one selected element.");
    }
    const previewCommit = this.#motion.beginPreviewCommit();
    this.#run(
      async (generation) => {
        try {
          const basisRevision = this.#model.revision;
          const preparedSnap = await preview?.prepareSnap?.();
          if (
            preparedSnap === "cancelled" ||
            this.#isCancelled(generation) ||
            this.#model.revision !== basisRevision
          )
            return false;
          const movement = preparedSnap ?? { delta, effect, snap };
          if (movement.snap !== null && elements.length !== 1) {
            throw new RangeError("Snapped movement requires one selected element.");
          }
          const scheduler = this.#scheduler(generation);
          const replacements =
            movement.snap === null
              ? await moveSelectionTimeSliced(elements, movement.delta, scheduler)
              : moveSelectionWithSnap(elements, movement.delta, movement.snap);
          if (replacements === null) return false;
          return await this.#commitApplied(
            elements,
            replacements,
            generation,
            previewCommit,
            movement.effect,
            { isCancelled: () => this.#model.revision !== basisRevision },
          );
        } finally {
          previewCommit.cancel();
        }
      },
      onCompleted,
      preview?.onSettled,
    );
    return true;
  }

  async #commitApplied(
    previous: readonly InkElementV1[],
    replacements: readonly InkElementV1[],
    generation: number,
    previewCommit:
      ReturnType<PreparedElementHistoryOptions["motion"]["beginPreviewCommit"]> | undefined,
    effect?: SelectionFrameHistoryEffect,
    conditions?: ReplacementCommitConditions,
  ): Promise<boolean> {
    const captured = captureElementReplacementHistory(previous, replacements);
    const committed = await this.#replace(
      replacements,
      generation,
      previewCommit === undefined ? undefined : previous.map(({ id }) => id),
      previewCommit,
      captured.capture,
      conditions,
    );
    if (!committed) return false;
    this.#registerApplied(captured, effect);
    return true;
  }

  #registerApplied(
    applied: ElementReplacementHistoryData,
    effect?: SelectionFrameHistoryEffect,
  ): void {
    if (applied.previous.length === 0 || applied.previous.length !== applied.replacements.length)
      return;
    const model = this.#model;
    const history = this.#history;
    const replay = (elements: readonly InkElementV1[]) =>
      applyPreparedHistoryReplacement(model, elements, () => history.isDisposed);
    history.registerApplied(
      {
        payloadBytes: applied.payloadBytes,
        redo: () => replay(applied.replacements as readonly InkElementV1[]),
        undo: () => replay(applied.previous as readonly InkElementV1[]),
      },
      effect,
    );
  }

  async #replace(
    elements: readonly InkElementV1[],
    generation: number,
    suppressMotionIds?: readonly string[],
    previewCommit?: ReturnType<PreparedElementHistoryOptions["motion"]["beginPreviewCommit"]>,
    capture?: (history: ElementReplacementHistoryData) => void,
    conditions?: ReplacementCommitConditions,
  ): Promise<boolean> {
    const basisRevision = this.#model.revision;
    const cancellation = {
      isCancelled: () =>
        this.#isCancelled(generation) ||
        this.#model.revision !== basisRevision ||
        (conditions?.isCancelled?.() ?? false),
    };
    const preparation = await this.#model.prepareElementReplacement(elements, cancellation);
    if (preparation.status !== "prepared" || preparation.token === null) return false;
    if (cancellation.isCancelled()) return false;
    if (
      conditions?.maxHistoryPayloadBytes !== undefined &&
      preparation.historyPayloadBytes !== undefined &&
      preparation.historyPayloadBytes > conditions.maxHistoryPayloadBytes
    ) {
      throw new RangeError("Element mutation exceeds the retained history payload limit.");
    }
    if (
      previewCommit !== undefined &&
      suppressMotionIds !== undefined &&
      !previewCommit.arm(suppressMotionIds)
    ) {
      return false;
    }
    return this.#model.commitPreparedElementReplacement(preparation.token, capture) === "committed";
  }

  #run(
    operation: (generation: number) => Promise<boolean>,
    onCompleted?: (committed: boolean) => void,
    onSettled?: () => void,
  ): void {
    const generation = ++this.#generation;
    const release = this.#model.beginInteractiveOperation?.();
    this.#setPending(true);
    void operation(generation)
      .catch(() => false)
      .finally(() => {
        try {
          release?.();
          this.#setPending(false);
        } finally {
          onSettled?.();
        }
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

async function applyPreparedHistoryReplacement(
  model: EditableDocumentModel,
  elements: readonly InkElementV1[],
  isCancelled: () => boolean,
): Promise<boolean> {
  const basisRevision = model.revision;
  const cancellation = { isCancelled: () => isCancelled() || model.revision !== basisRevision };
  if (cancellation.isCancelled()) return false;
  const preparation = await model.prepareElementReplacement(elements, cancellation);
  if (preparation.status !== "prepared" || preparation.token === null || cancellation.isCancelled())
    return false;
  return model.commitPreparedElementReplacement(preparation.token) === "committed";
}

function requiresSlicedMove(
  elements: readonly InkElementV1[],
  snap: SelectionMoveSnap | null,
): boolean {
  return (
    elements.length > SYNCHRONOUS_SELECTION_LIMIT ||
    hasLinearConnectionDependencies(elements) ||
    snap?.candidate.anchor.kind === "linear-endpoint"
  );
}
