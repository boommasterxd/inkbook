import type { Bounds } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import {
  resolveConnectedTranslationPreview,
  type ElementStore,
} from "../../../domain/store/public";
import type { GesturePreview, GesturePreviewStart } from "../../../editor/gestures/public";
import { lassoBounds, moveSelection, selectByLassoQuery } from "../../../editor/selection/public";

import type { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ElementSceneStore } from "./scene-store";

interface SelectionPreviewRenderer {
  clearElementPreviews?(): void;
  clearPreviewTransforms(): void;
  setElementPreviews?(elements: readonly InkElementV1[], version: number): void;
  setOverlayPath(d: string | null): void;
  setPreviewTransform(ids: readonly string[], transform: string | null, version: number): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
}

export interface SelectionEdgeDragPort {
  begin(): void;
  finish(outcome: "cancel" | "commit"): void;
  setBottomEdge(active: boolean): void;
  update(screenPointer: PointV1): void;
}

export interface SelectionPreviewOptions {
  readonly history: ActiveEditorHistory;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly pageToViewport?: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: SelectionPreviewRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selectionEdgeDrag?: SelectionEdgeDragPort;
  readonly selection: () => ReadonlySet<string>;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly start: GesturePreviewStart;
  readonly store: ElementStore;
}

export class LassoPreview implements GesturePreview {
  readonly #options: SelectionPreviewOptions;
  #bounds: Bounds;
  #finished = false;

  public constructor(options: SelectionPreviewOptions) {
    this.#options = options;
    this.#bounds = lassoBounds(options.start.pointer, options.start.pointer);
    this.#render();
  }

  public commit(): boolean {
    this.#assertActive();
    this.#finished = true;
    const previous = this.#options.selection();
    const next = selectByLassoQuery(previous, this.#bounds, this.#options.start.additive, (sink) =>
      this.#options.sceneStore.query(this.#bounds, {
        add: (id) => {
          const bounds = this.#options.store.get(id)?.bounds;
          if (bounds !== undefined) sink.add(id, bounds);
        },
      }),
    );
    this.#options.renderer.setOverlayPath(null);
    this.#options.setSelection(next);
    return next !== previous;
  }

  public revert(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#options.renderer.setOverlayPath(null);
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.#assertActive();
    this.#bounds = lassoBounds(this.#options.start.pointer, pointer);
    this.#render();
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed lasso preview cannot be updated.");
  }

  #render(): void {
    const { minX, minY, maxX, maxY } = this.#bounds;
    const topLeft = this.#options.pageToScreen({ x: minX, y: minY });
    const bottomRight = this.#options.pageToScreen({ x: maxX, y: maxY });
    this.#options.renderer.setOverlayPath(
      `M ${String(topLeft.x)} ${String(topLeft.y)} L ${String(bottomRight.x)} ${String(topLeft.y)} ` +
        `L ${String(bottomRight.x)} ${String(bottomRight.y)} L ${String(topLeft.x)} ${String(bottomRight.y)} Z`,
    );
  }
}

export class MovePreview implements GesturePreview {
  readonly #connectedTargetIds: readonly string[];
  readonly #elements: readonly InkElementV1[];
  readonly #ids: readonly string[];
  readonly #options: SelectionPreviewOptions;
  readonly #selectedIds: ReadonlySet<string>;
  #current = { x: 0, y: 0 };
  #finished = false;
  #version = 0;

  public constructor(options: SelectionPreviewOptions) {
    this.#options = options;
    this.#selectedIds = options.selection();
    const elements: InkElementV1[] = [];
    for (const id of this.#selectedIds) {
      const element = options.store.get(id)?.element;
      if (element !== undefined) elements.push(element as InkElementV1);
    }
    this.#elements = elements;
    this.#ids = this.#elements.map(({ id }) => id);
    this.#connectedTargetIds = this.#ids.filter((id) => {
      let connected = false;
      options.store.visitDependents(id, () => {
        connected = true;
      });
      return connected;
    });
    options.selectionEdgeDrag?.begin();
  }

  public commit(): boolean {
    this.#assertActive();
    this.#finished = true;
    let committed = false;
    if (this.#current.x !== 0 || this.#current.y !== 0) {
      committed = this.#options.preparedHistory.commitMove(this.#elements, this.#current);
      if (!committed) {
        const plan = this.#options.store.planPageBoundedReplacements(
          moveSelection(this.#elements, this.#current),
        );
        if (plan !== null) {
          this.#options.renderer.suppressMotionForNextDelta(this.#ids);
          committed = this.#options.history.replace(this.#elements, plan.replacements);
        }
      }
    }
    this.#options.renderer.clearPreviewTransforms();
    this.#options.renderer.clearElementPreviews?.();
    this.#options.selectionEdgeDrag?.finish("commit");
    return committed;
  }

  public revert(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#options.renderer.clearPreviewTransforms();
    this.#options.renderer.clearElementPreviews?.();
    this.#options.selectionEdgeDrag?.finish("cancel");
  }

  public update(pointer: GesturePreviewStart["pointer"]): void {
    this.#assertActive();
    this.#current = {
      x: pointer.x - this.#options.start.pointer.x,
      y: pointer.y - this.#options.start.pointer.y,
    };
    this.#version += 1;
    this.#options.renderer.setPreviewTransform(
      this.#ids,
      `translate(${String(this.#current.x)} ${String(this.#current.y)})`,
      this.#version,
    );
    this.#renderConnectedDependents();
    this.#options.selectionEdgeDrag?.update(
      (this.#options.pageToViewport ?? this.#options.pageToScreen)(pointer),
    );
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed move preview cannot be updated.");
  }

  #renderConnectedDependents(): void {
    if (this.#options.renderer.setElementPreviews === undefined) return;
    try {
      const dependents = resolveConnectedTranslationPreview(
        this.#options.store,
        this.#connectedTargetIds,
        this.#selectedIds,
        this.#current,
      );
      this.#options.renderer.setElementPreviews(dependents, this.#version);
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      this.#options.renderer.setElementPreviews([], this.#version);
    }
  }
}
