import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import {
  moveSelectionTimeSliced,
  type SelectionHandleSession,
} from "../../../editor/selection/public";
import type { TransformSliceScheduler } from "../../../editor/selection/transforms";
import type { EditableDocumentModel } from "../vault-document-session";
import type { SelectionFrameHistoryEffect } from "../../../editor/selection/public";

import type { ActiveEditorHistory } from "./history";

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
  readonly ownerWindow: Window;
  readonly sliceBudgetMs?: () => number;
}

type SelectionFrameEffectFactory = (
  replacements: readonly InkElementV1[],
) => SelectionFrameHistoryEffect | undefined;

export class PreparedElementHistory {
  readonly #history: ActiveEditorHistory;
  readonly #isAttached: () => boolean;
  readonly #model: EditableDocumentModel;
  readonly #motion: PreparedElementHistoryOptions["motion"];
  readonly #onPendingChanged: (pending: boolean) => void;
  readonly #ownerWindow: Window;
  readonly #sliceBudgetMs: () => number;
  readonly #pendingFrames = new Map<number, () => void>();
  #disposed = false;
  #generation = 0;
  #pending = false;

  public constructor(options: PreparedElementHistoryOptions) {
    this.#history = options.history;
    this.#isAttached = options.isAttached;
    this.#model = options.model;
    this.#motion = options.motion;
    this.#onPendingChanged = options.onPendingChanged;
    this.#ownerWindow = options.ownerWindow;
    this.#sliceBudgetMs = options.sliceBudgetMs ?? (() => 8);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    for (const [frame, resolve] of this.#pendingFrames) {
      this.#ownerWindow.cancelAnimationFrame(frame);
      resolve();
    }
    this.#pendingFrames.clear();
    this.#setPending(false);
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
    await this.#yieldHostFrame();
    this.#history.registerAppliedReplacement(
      previous,
      replacements,
      {
        redo: () => this.#replace(replacements, this.#generation),
        undo: () => this.#replace(previous, this.#generation),
      },
      effect,
    );
    return true;
  }

  async #replace(
    elements: readonly InkElementV1[],
    generation: number,
    suppressMotionIds?: readonly string[],
    previewCommit?: ReturnType<PreparedElementHistoryOptions["motion"]["beginPreviewCommit"]>,
  ): Promise<boolean> {
    const cancellation = { isCancelled: () => this.#isCancelled(generation) };
    const preparation = await this.#model.prepareElementReplacement(elements, cancellation);
    if (preparation.status !== "prepared" || preparation.token === null) return false;
    if (this.#isCancelled(generation)) return false;
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
    this.#setPending(true);
    void operation(generation)
      .catch(() => false)
      .then((committed) => {
        if (!this.#disposed && generation === this.#generation) onCompleted?.(committed);
      })
      .finally(() => {
        if (generation === this.#generation) this.#setPending(false);
      });
  }

  #scheduler(generation: number): TransformSliceScheduler {
    let deadline = this.#ownerWindow.performance.now() + this.#sliceBudgetMs();
    return {
      isCancelled: () => this.#isCancelled(generation),
      shouldYield: () => this.#ownerWindow.performance.now() >= deadline,
      yieldControl: () =>
        this.#yieldHostFrame().then(() => {
          deadline = this.#ownerWindow.performance.now() + this.#sliceBudgetMs();
        }),
    };
  }

  #yieldHostFrame(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const frame = this.#ownerWindow.requestAnimationFrame(() => {
        this.#pendingFrames.delete(frame);
        resolve();
      });
      this.#pendingFrames.set(frame, resolve);
    });
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
