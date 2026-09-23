import { calculateElementBounds } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { GesturePreview } from "../../../editor/gestures/public";
import { SnapCandidateScratch } from "../../../editor/snapping/snap-candidate";
import {
  ConnectedSelectionPreviewSession,
  moveSelectionWithSnap,
  resolveSelectionMoveSnap,
  type ConnectedSelectionPreview,
  type OrientedSelectionFrame,
  type SelectedElementGeometry,
  type SelectionFrameHistoryEffect,
  type SelectionMoveSnap,
  type SelectionPreviewTransform,
} from "../../../editor/selection/public";

import { commitPreviewReplacement } from "./preview-replacement-commit";
import { selectionOverlayFill, selectionOverlayPaths } from "./selection-overlay-path";
import type { SelectionPreviewOptions } from "./selection-preview-contracts";
import { snapMarkerPath } from "./snap-marker-path";

export class MovePreview implements GesturePreview {
  readonly #connectedPreview: ConnectedSelectionPreviewSession;
  readonly #elements: readonly InkElementV1[];
  readonly #frameScheduler: SelectionPreviewOptions["frameScheduler"];
  readonly #ids: readonly string[];
  readonly #options: SelectionPreviewOptions;
  readonly #selectedIds: ReadonlySet<string>;
  readonly #selectedGeometry: readonly SelectedElementGeometry[];
  readonly #selectedMaximumBottom: number;
  readonly #selectionFrame: OrientedSelectionFrame | null;
  readonly #snapScratch = new SnapCandidateScratch();
  readonly #transformIds: readonly string[];
  #current = { x: 0, y: 0 };
  #currentViewport: PointV1 | undefined;
  #finished = false;
  #frameHandle: number | undefined;
  #lastPointer: SelectionPreviewOptions["start"]["pointer"];
  #moveSnap: SelectionMoveSnap | null = null;
  #previewMaximumBottomValue: number | undefined;
  #pendingPointer: SelectionPreviewOptions["start"]["pointer"] | undefined;
  #version = 0;

  public constructor(options: SelectionPreviewOptions) {
    this.#options = options;
    this.#frameScheduler = options.frameScheduler;
    this.#selectedIds = options.selection();
    const elements: InkElementV1[] = [];
    const selectedGeometry: SelectedElementGeometry[] = [];
    for (const id of this.#selectedIds) {
      const record = options.store.get(id);
      if (record === undefined) continue;
      const element = record.element as InkElementV1;
      elements.push(element);
      selectedGeometry.push({ bounds: record.bounds, element });
    }
    this.#elements = elements;
    this.#selectedGeometry = selectedGeometry;
    this.#selectedMaximumBottom = selectedGeometry.reduce(
      (maximum, selected) => Math.max(maximum, selected.bounds.maxY),
      Number.NEGATIVE_INFINITY,
    );
    this.#selectionFrame = options.selectionFrames?.current(selectedGeometry) ?? null;
    this.#ids = this.#elements.map(({ id }) => id);
    this.#connectedPreview = new ConnectedSelectionPreviewSession(
      options.store,
      this.#elements,
      this.#selectedIds,
    );
    this.#transformIds =
      options.renderer.setElementPreviews === undefined
        ? this.#ids
        : this.#ids.filter((id) => !this.#connectedPreview.selectedPreviewIds.has(id));
    this.#lastPointer = options.start.pointer;
    this.#currentViewport = (options.pageToViewport ?? options.pageToScreen)(options.start.pointer);
    options.selectionEdgeDrag?.begin(() => this.#refreshAfterViewportChange());
  }

  public commit(): boolean {
    this.#assertActive();
    this.#flushPendingPointer();
    this.#finished = true;
    let committed = false;
    let prepared = false;
    try {
      if (this.#current.x !== 0 || this.#current.y !== 0) {
        const previewMaximumBottom = this.#previewMaximumBottomValue;
        const effect = this.#options.selectionFrames?.transition(
          this.#selectionFrame,
          this.#translationTransform(),
        );
        prepared =
          this.#moveSnap === null &&
          this.#options.preparedHistory.commitMove(
            this.#elements,
            this.#current,
            (result) => {
              if (!result) this.#renderSelectionOverlay(null);
              if (result) this.#options.selectionEdgeDrag?.finish(true, previewMaximumBottom);
              else this.#options.selectionEdgeDrag?.finish(false);
            },
            effect,
          );
        committed = prepared || this.#commitSynchronous(effect);
      }
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
    } finally {
      this.#options.renderer.clearPreviewTransforms();
      this.#options.renderer.clearElementPreviews?.();
      this.#options.renderer.setSnapMarkerPath?.(null);
      this.#renderSelectionOverlay(committed ? this.#translationTransform() : null);
      if (prepared) this.#options.selectionEdgeDrag?.stop();
      else if (committed) {
        this.#options.selectionEdgeDrag?.finish(true, this.#previewMaximumBottomValue);
      } else this.#options.selectionEdgeDrag?.finish(false);
    }
    return committed;
  }

  public revert(): void {
    if (this.#finished) return;
    this.#discardPendingPointer();
    this.#finished = true;
    this.#options.renderer.clearPreviewTransforms();
    this.#options.renderer.clearElementPreviews?.();
    this.#options.renderer.setSnapMarkerPath?.(null);
    this.#renderSelectionOverlay(null);
    this.#options.selectionEdgeDrag?.finish(false);
  }

  public update(pointer: SelectionPreviewOptions["start"]["pointer"]): void {
    this.#assertActive();
    const viewport = (this.#options.pageToViewport ?? this.#options.pageToScreen)(pointer);
    this.#currentViewport = viewport;
    this.#pendingPointer = pointer;
    this.#schedulePointerFrame();
  }

  public updateSamples(samples: readonly SelectionPreviewOptions["start"]["pointer"][]): void {
    const latest = samples[samples.length - 1];
    if (latest !== undefined) this.update(latest);
  }

  #commitSynchronous(effect: SelectionFrameHistoryEffect | undefined): boolean {
    const plan = this.#options.store.planReplacements(this.#movedElements());
    if (plan === null) return false;
    return commitPreviewReplacement({
      effect,
      history: this.#options.history,
      motion: this.#options.renderer,
      previous: this.#elements,
      replacements: plan.replacements,
    });
  }

  #renderUpdate(pointer: SelectionPreviewOptions["start"]["pointer"]): number {
    const rawDelta = {
      x: pointer.x - this.#options.start.pointer.x,
      y: pointer.y - this.#options.start.pointer.y,
    };
    this.#moveSnap = this.#resolveMoveSnap(rawDelta);
    this.#current = this.#moveSnap?.delta ?? rawDelta;
    this.#version += 1;
    const transform = this.#translationTransform();
    const connected = this.#renderConnectedElements(transform);
    this.#options.renderer.setPreviewTransform(
      this.#transformIds,
      `translate(${String(this.#current.x)} ${String(this.#current.y)})`,
      this.#version,
    );
    this.#renderSelectionOverlay(transform, connected);
    this.#options.renderer.setSnapMarkerPath?.(
      this.#moveSnap === null
        ? null
        : snapMarkerPath(this.#options.pageToScreen(this.#moveSnap.candidate.point)),
    );
    const maximumBottom = this.#previewMaximumBottom(connected);
    this.#previewMaximumBottomValue = maximumBottom;
    return maximumBottom;
  }

  #projectViewportPointer(
    pointer: SelectionPreviewOptions["start"]["pointer"],
    viewport: PointV1 | undefined,
  ): SelectionPreviewOptions["start"]["pointer"] {
    const page = viewport === undefined ? undefined : this.#options.viewportToPage?.(viewport);
    return page === undefined ? pointer : { ...pointer, ...page };
  }

  #refreshAfterViewportChange(): void {
    if (this.#finished || this.#currentViewport === undefined) return;
    const source = this.#pendingPointer ?? this.#lastPointer;
    this.#discardPendingPointer();
    const pointer = this.#projectViewportPointer(source, this.#currentViewport);
    this.#lastPointer = pointer;
    const maximumBottom = this.#renderUpdate(pointer);
    this.#options.selectionEdgeDrag?.updatePreviewBottom(maximumBottom);
    this.#options.selectionEdgeDrag?.update(this.#currentViewport);
    this.#options.renderer.flushPointerFeedbackFrame?.();
  }

  #assertActive(): void {
    if (this.#finished) throw new Error("A completed move preview cannot be updated.");
  }

  #renderConnectedElements(transform: SelectionPreviewTransform): ConnectedSelectionPreview {
    if (this.#options.renderer.setElementPreviews === undefined) {
      return { elements: [], selectedPreviewIds: new Set() };
    }
    try {
      const connected = this.#connectedPreview.update(transform);
      this.#options.renderer.setElementPreviews(connected.elements, this.#version);
      return connected;
    } catch (error: unknown) {
      if (!(error instanceof RangeError)) throw error;
      this.#options.renderer.setElementPreviews([], this.#version);
      return { elements: [], selectedPreviewIds: new Set() };
    }
  }

  #renderSelectionOverlay(
    transform: SelectionPreviewTransform | null,
    connected: ConnectedSelectionPreview = { elements: [], selectedPreviewIds: new Set() },
  ): void {
    const exact =
      this.#selectedGeometry.length === 1 &&
      connected.selectedPreviewIds.has(this.#selectedGeometry[0]!.element.id)
        ? this.#connectedSelectionGeometry(connected.elements)
        : null;
    const selected = exact ?? this.#selectedGeometry;
    const paths = selectionOverlayPaths(selected, {
      pageToScreen: this.#options.pageToScreen,
      frame: exact === null ? this.#selectionFrame : null,
      transform: exact === null ? transform : null,
      zoom: this.#selectionZoom(),
    });
    this.#options.renderer.setSelectionOverlayPath?.(
      paths.outline,
      selectionOverlayFill(selected),
      paths.handles,
    );
  }

  #connectedSelectionGeometry(
    elements: readonly InkElementV1[],
  ): readonly SelectedElementGeometry[] {
    const id = this.#selectedGeometry[0]!.element.id;
    const element = elements.find((candidate) => candidate.id === id);
    return element === undefined
      ? this.#selectedGeometry
      : [{ bounds: calculateElementBounds(element), element }];
  }

  #selectionZoom(): number {
    const configured = this.#options.zoom?.();
    if (configured !== undefined && Number.isFinite(configured) && configured > 0)
      return configured;
    const origin = this.#options.pageToScreen({ x: 0, y: 0 });
    const unit = this.#options.pageToScreen({ x: 1, y: 0 });
    const inferred = Math.hypot(unit.x - origin.x, unit.y - origin.y);
    return Number.isFinite(inferred) && inferred > 0 ? inferred : 1;
  }

  #previewMaximumBottom(connected: ConnectedSelectionPreview): number {
    let maximumBottom = this.#selectedMaximumBottom + this.#current.y;
    for (const element of connected.elements) {
      maximumBottom = Math.max(maximumBottom, calculateElementBounds(element).maxY);
    }
    return maximumBottom;
  }

  #movedElements(): InkElementV1[] {
    return moveSelectionWithSnap(this.#elements, this.#current, this.#moveSnap);
  }

  #resolveMoveSnap(rawDelta: PointV1): SelectionMoveSnap | null {
    if (this.#selectedIds.size !== 1) return null;
    const configured = this.#options.connectionSnapping;
    if (typeof configured === "function" ? !configured() : configured === false) return null;
    return resolveSelectionMoveSnap({
      canConnect: (sourceId, targetId) => this.#options.sceneStore.canConnect(sourceId, targetId),
      current: this.#moveSnap,
      elements: this.#elements,
      pointerType: this.#options.start.pointer.pointerType,
      rawDelta,
      scratch: this.#snapScratch,
      selectedIds: this.#selectedIds,
      spatial: { query: (bounds, sink) => this.#options.sceneStore.query(bounds, sink) },
      targets: { get: (id) => this.#options.sceneStore.getSnapTarget(id) },
      zoom: this.#selectionZoom(),
    });
  }

  #translationTransform(): SelectionPreviewTransform {
    return { delta: this.#current, kind: "translate" };
  }

  #schedulePointerFrame(): void {
    const scheduler = this.#frameScheduler;
    if (scheduler === undefined) {
      this.#applyPendingPointer();
      return;
    }
    if (this.#frameHandle !== undefined) return;
    let completedSynchronously = false;
    let handle = 0;
    handle = scheduler.requestAnimationFrame(() => {
      completedSynchronously = true;
      if (this.#frameHandle === handle) this.#frameHandle = undefined;
      this.#applyPendingPointer();
    });
    if (!completedSynchronously) this.#frameHandle = handle;
  }

  #applyPendingPointer(): void {
    const pointer = this.#pendingPointer;
    const viewport = this.#currentViewport;
    if (pointer === undefined || viewport === undefined || this.#finished) return;
    this.#pendingPointer = undefined;
    const current = this.#projectViewportPointer(pointer, viewport);
    this.#lastPointer = current;
    const maximumBottom = this.#renderUpdate(current);
    this.#options.selectionEdgeDrag?.updatePreviewBottom(maximumBottom);
    this.#options.selectionEdgeDrag?.update(viewport);
    this.#options.renderer.flushPointerFeedbackFrame?.();
  }

  #flushPendingPointer(): void {
    this.#cancelPointerFrame();
    this.#applyPendingPointer();
  }

  #discardPendingPointer(): void {
    this.#cancelPointerFrame();
    this.#pendingPointer = undefined;
  }

  #cancelPointerFrame(): void {
    if (this.#frameHandle === undefined) return;
    this.#frameScheduler?.cancelAnimationFrame(this.#frameHandle);
    this.#frameHandle = undefined;
  }
}
