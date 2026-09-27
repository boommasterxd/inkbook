import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { SnappingSettingsV1 } from "../../../domain/settings/types";
import type { ToolSystemCursor } from "../../../editor/input/tool-cursor";
import type { PointerSample } from "../../../editor/input/index";
import {
  ConnectedSelectionPreviewSession,
  HitTestScratch,
  findSelectionHandle,
  selectionOverlayGeometry,
  type SelectionOverlayGeometry,
  SelectionFrameSession,
  SelectionHandleSession,
  type SelectedElementGeometry,
  type OrientedSelectionFrame,
  type SelectionHandle,
  type SelectionHandlePreview,
} from "../../../editor/selection/public";
import type { EditableDocumentModel } from "../vault-document-session";

import {
  selectionCursorContainsPoint,
  selectionCursorRadius,
  selectionHandleCursor,
} from "./selection-cursor";
import type { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ElementSceneStore } from "./scene-store";
import { selectionHandleAction } from "./selection-handle-action";
import { activeSnapFeatures } from "./snapping-settings";
import { commitPreviewReplacement } from "./preview-replacement-commit";
import { SelectionScalePreviewPlan } from "./selection-scale-preview";
import { SelectionHandlePresentation, type HandleInteractionRenderer } from "./handle-presentation";

export interface ActiveEditorHandleInteractionOptions {
  readonly frameScheduler: HandleFrameScheduler;
  readonly history: ActiveEditorHistory;
  readonly layout?: {
    begin(): void;
    finish(committed: boolean, previewMaximumBottom?: number): void;
    updateBottom(maximumBottom: number): void;
  };
  readonly model: EditableDocumentModel;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: HandleInteractionRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selectionFrames?: SelectionFrameSession;
  readonly selection: () => ReadonlySet<string>;
  readonly snapping?: () => SnappingSettingsV1;
  readonly zoom: () => number;
}

export type { HandleInteractionRenderer } from "./handle-presentation";

const NO_SCALE_TRANSFORM_IDS: readonly string[] = [];

export interface HandleFrameScheduler {
  cancelAnimationFrame(handle: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
}

interface PendingHandleSample {
  readonly pointer: PointerSample;
  readonly snappingInverted: boolean;
  readonly uniformScale: boolean;
}

interface ActiveHandleGesture {
  readonly cursor: ToolSystemCursor;
  readonly connectedPreview: ConnectedSelectionPreviewSession;
  readonly connectedTransformIds: readonly string[];
  readonly grabOffset: PointV1;
  readonly pointerId: number;
  readonly pointerType: PointerSample["pointerType"];
  readonly selected: readonly SelectedElementGeometry[];
  readonly frame: OrientedSelectionFrame | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly scalePreview: SelectionScalePreviewPlan;
  readonly session: SelectionHandleSession;
  readonly snapping: SnappingSettingsV1 | undefined;
}

export class ActiveEditorHandleInteraction {
  readonly #frameScheduler: HandleFrameScheduler;
  readonly #history: ActiveEditorHistory;
  readonly #layout: ActiveEditorHandleInteractionOptions["layout"];
  readonly #model: EditableDocumentModel;
  readonly #presentation: SelectionHandlePresentation;
  readonly #preparedHistory: PreparedElementHistory;
  readonly #renderer: HandleInteractionRenderer;
  readonly #sceneStore: ElementSceneStore;
  readonly #selectionFrames: SelectionFrameSession;
  readonly #selection: () => ReadonlySet<string>;
  readonly #snapping: () => SnappingSettingsV1 | undefined;
  readonly #zoom: () => number;
  #renderedSelection: ReadonlySet<string> | undefined;
  #renderedRevision = -1;
  #renderedGeometry: readonly SelectedElementGeometry[] = [];
  #renderedFrame: OrientedSelectionFrame | null = null;
  #renderedZoom = 1;
  #cursorGeometry: SelectionOverlayGeometry | null = null;
  #cursorRotation = 0;
  #cursorLinear: InkElementV1 | undefined;
  readonly #cursorLinearHit = new HitTestScratch();
  #active: ActiveHandleGesture | undefined;
  #frameHandle: number | undefined;
  #pendingSample: PendingHandleSample | undefined;
  #previewMaximumBottom: number | undefined;

  public constructor(options: ActiveEditorHandleInteractionOptions) {
    this.#frameScheduler = options.frameScheduler;
    this.#history = options.history;
    this.#layout = options.layout;
    this.#model = options.model;
    this.#preparedHistory = options.preparedHistory;
    this.#renderer = options.renderer;
    this.#presentation = new SelectionHandlePresentation(
      options.renderer,
      options.pageToScreen,
      options.zoom,
    );
    this.#sceneStore = options.sceneStore;
    this.#selectionFrames = options.selectionFrames ?? new SelectionFrameSession();
    this.#selection = options.selection;
    this.#snapping = options.snapping ?? (() => undefined);
    this.#zoom = options.zoom;
  }

  public get activePointerId(): number | undefined {
    return this.#active?.pointerId;
  }

  public get activePointerType(): PointerSample["pointerType"] | undefined {
    return this.#active?.pointerType;
  }

  public cursorAt(pointer: PointerSample): ToolSystemCursor | undefined {
    if (this.#active !== undefined) return this.#active.cursor;
    const geometry = this.#cursorGeometry;
    if (geometry === null) return undefined;
    const handle = findSelectionHandle(
      geometry.handles,
      pointer,
      this.#zoom(),
      selectionCursorRadius(geometry.outline, pointer, this.#zoom()),
    );
    if (handle !== null) return selectionHandleCursor(handle, this.#cursorRotation);
    if (selectionCursorContainsPoint(geometry.outline, pointer)) return "move";
    if (this.#cursorLinear === undefined) return undefined;
    this.#cursorLinearHit.begin(pointer, pointer.pointerType, this.#zoom());
    this.#cursorLinearHit.consider(this.#cursorLinear.id, "content", this.#cursorLinear, 0);
    return this.#cursorLinearHit.finish() === null ? undefined : "move";
  }

  public cancel(pointerId?: number): boolean {
    const active = this.#active;
    if (active === undefined || (pointerId !== undefined && active.pointerId !== pointerId)) {
      return false;
    }
    this.#discardPendingSample();
    active.session.cancel();
    this.#layout?.finish(false);
    this.#finish();
    return true;
  }

  public dispose(): void {
    this.cancel();
    this.#presentation.dispose();
    this.#cursorGeometry = null;
    this.#cursorLinear = undefined;
    this.#renderedSelection = undefined;
    this.#renderedGeometry = [];
    this.#renderedFrame = null;
  }

  public pointerDown(
    pointer: PointerSample,
    uniformScale = false,
    snappingInverted = false,
  ): boolean {
    if (this.#active !== undefined) return false;
    const selected = this.#selectedGeometry();
    const frame = this.#selectionFrames.current(selected);
    this.#cacheCursorGeometry(selected, frame);
    const handles = this.#cursorGeometry?.handles ?? [];
    const handle = findSelectionHandle(
      handles,
      pointer,
      this.#zoom(),
      selectionCursorRadius(this.#cursorGeometry?.outline ?? null, pointer, this.#zoom()),
    );
    if (handle === null) return false;
    const elements = selected.map(({ element }) => element);
    const selectedIds = new Set(elements.map(({ id }) => id));
    const action = selectionHandleAction(handle, selected, frame);
    const sessionStart = handleSessionStart(handle);
    const configuredSnapping = this.#snapping();
    const snapping =
      configuredSnapping === undefined ? undefined : structuredClone(configuredSnapping);
    const ids = elements.map(({ id }) => id);
    const connectedPreview = new ConnectedSelectionPreviewSession(
      this.#model.store,
      elements,
      selectedIds,
    );
    const scalePreview = new SelectionScalePreviewPlan(selected);
    const connectedTransformIds = ids.filter((id) => !connectedPreview.selectedPreviewIds.has(id));
    this.#active = {
      cursor:
        handle.kind === "rotate" ? "grabbing" : selectionHandleCursor(handle, this.#cursorRotation),
      connectedPreview,
      connectedTransformIds,
      frame,
      grabOffset: {
        x: pointer.x - sessionStart.x,
        y: pointer.y - sessionStart.y,
      },
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      selected,
      selectedIds,
      scalePreview,
      snapping,
      session: new SelectionHandleSession({
        action,
        elements,
        planner: this.#model.store,
        snap: {
          canConnect: (sourceId, targetId) => this.#sceneStore.canConnect(sourceId, targetId),
          features: activeSnapFeatures(snapping, snappingInverted),
          pointerType: pointer.pointerType,
          spatial: { query: (bounds, sink) => this.#sceneStore.query(bounds, sink) },
          targets: {
            get: (id) => this.#sceneStore.getSnapTarget(id),
          },
          zoom: this.#zoom(),
        },
        startPointer: sessionStart,
        uniformScale,
      }),
    };
    this.#model.setGestureActive(true);
    this.#previewMaximumBottom = undefined;
    this.#layout?.begin();
    return true;
  }

  public pointerMove(
    pointer: PointerSample,
    uniformScale = false,
    snappingInverted = false,
  ): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointer.pointerId) return false;
    this.#pendingSample = { pointer, snappingInverted, uniformScale };
    this.#schedulePointerFrame(active);
    return true;
  }

  #applyPendingSample(active: ActiveHandleGesture): void {
    const sample = this.#pendingSample;
    if (sample === undefined || this.#active !== active) return;
    this.#pendingSample = undefined;
    const { pointer, snappingInverted, uniformScale } = sample;
    const preview = active.session.update(
      {
        x: pointer.x - active.grabOffset.x,
        y: pointer.y - active.grabOffset.y,
      },
      {
        snapFeatures: activeSnapFeatures(active.snapping, snappingInverted),
        uniformScale,
      },
    );
    const connected = this.#connectedPreview(active, preview);
    const scale = active.scalePreview.resolve(preview);
    if (preview.transform?.kind !== "scale") {
      this.#renderer.clearProgressiveElementPreviews?.();
    }
    this.#presentation.renderTransform(
      preview.transform?.kind === "scale" ? NO_SCALE_TRANSFORM_IDS : active.connectedTransformIds,
      preview.transform,
    );
    this.#updatePreviewBottom(
      this.#presentation.renderPreview(active, preview, connected, scale.elements),
    );
    if (preview.transform?.kind === "scale") {
      const materialize = active.session.createScalePreviewMaterializer();
      if (materialize !== undefined) {
        this.#presentation.renderProgressive(
          active.scalePreview.progressiveIds,
          active.scalePreview.materializer(materialize),
          preview.transform,
        );
      }
    }
    this.#renderer.flushPointerFeedbackFrame();
  }

  public pointerUp(pointerId: number): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointerId) return false;
    this.#cancelPointerFrame();
    this.#applyPendingSample(active);
    const commit = active.session.prepareCommit();
    const frameEffect = (replacements: readonly InkElementV1[]) =>
      active.session.preview.transform?.kind === "scale"
        ? this.#selectionFrames.rebase(
            active.frame,
            replacements.filter(({ id }) => active.selectedIds.has(id)),
          )
        : this.#selectionFrames.transition(active.frame, active.session.preview.transform);
    if (commit.status === "ready") {
      const committed = commitPreviewReplacement({
        effect: frameEffect(commit.replacements),
        history: this.#history,
        motion: this.#renderer,
        previous: commit.previous,
        replacements: commit.replacements,
      });
      this.#layout?.finish(committed, this.#previewMaximumBottom);
    } else if (commit.status === "time-sliced-required") {
      const previewMaximumBottom = this.#previewMaximumBottom;
      const accepted = this.#preparedHistory.commitHandle(
        active.session,
        (committed) => {
          this.#layout?.finish(committed, previewMaximumBottom);
        },
        frameEffect,
      );
      if (!accepted) this.#layout?.finish(false);
    } else {
      this.#layout?.finish(false);
    }
    this.#finish();
    return true;
  }

  public renderSelection(): void {
    if (this.#active !== undefined) return;
    const selected = this.#selectedGeometry();
    const frame = this.#selectionFrames.current(selected);
    this.#cacheCursorGeometry(selected, frame);
    this.#renderedSelection = this.#selection();
    this.#renderedRevision = this.#model.revision;
    this.#renderedGeometry = selected;
    this.#renderedZoom = this.#zoom();
    const outline = this.#cursorGeometry?.outline;
    this.#renderedFrame =
      frame ??
      (selected.length === 1 &&
      selected[0]!.element.kind === "stroke" &&
      outline?.kind === "polygon"
        ? {
            points: outline.points as OrientedSelectionFrame["points"],
            rotation: selected[0]!.element.rotation,
          }
        : null);
    this.#presentation.renderGeometry(selected, this.#cursorGeometry);
  }

  public renderCameraSelection(): void {
    if (this.#active !== undefined) return;
    if (
      this.#renderedRevision !== this.#model.revision ||
      this.#renderedSelection !== this.#selection()
    ) {
      this.renderSelection();
      return;
    }
    if (this.#renderedZoom !== this.#zoom()) {
      this.#cacheCursorGeometry(this.#renderedGeometry, this.#renderedFrame);
      this.#renderedZoom = this.#zoom();
    }
    this.#presentation.renderGeometry(this.#renderedGeometry, this.#cursorGeometry);
  }

  #cacheCursorGeometry(
    selected: readonly SelectedElementGeometry[],
    frame: OrientedSelectionFrame | null,
  ): void {
    this.#cursorGeometry = selectionOverlayGeometry(selected, this.#zoom(), null, frame);
    this.#cursorLinear =
      this.#cursorGeometry?.outline.kind === "linear" ? selected[0]?.element : undefined;
    this.#cursorRotation =
      selected.length === 1 && selected[0]!.element.kind !== "stroke"
        ? selected[0]!.element.rotation
        : (frame?.rotation ?? 0);
  }

  #finish(): void {
    this.#discardPendingSample();
    this.#active = undefined;
    this.#previewMaximumBottom = undefined;
    this.#model.setGestureActive(false);
    this.#presentation.clearPreviews();
    this.renderCameraSelection();
  }

  #schedulePointerFrame(active: ActiveHandleGesture): void {
    if (this.#frameHandle !== undefined) return;
    let completedSynchronously = false;
    let handle = 0;
    handle = this.#frameScheduler.requestAnimationFrame(() => {
      completedSynchronously = true;
      if (this.#frameHandle === handle) this.#frameHandle = undefined;
      if (this.#active === active) this.#applyPendingSample(active);
    });
    if (!completedSynchronously) this.#frameHandle = handle;
  }

  #discardPendingSample(): void {
    this.#cancelPointerFrame();
    this.#pendingSample = undefined;
  }

  #cancelPointerFrame(): void {
    if (this.#frameHandle === undefined) return;
    this.#frameScheduler.cancelAnimationFrame(this.#frameHandle);
    this.#frameHandle = undefined;
  }

  #updatePreviewBottom(maximumBottom: number | undefined): void {
    if (maximumBottom === undefined) return;
    this.#previewMaximumBottom = Math.max(
      this.#previewMaximumBottom ?? maximumBottom,
      maximumBottom,
    );
    this.#layout?.updateBottom(this.#previewMaximumBottom);
  }

  #connectedPreview(
    active: ActiveHandleGesture,
    preview: SelectionHandlePreview,
  ): {
    readonly elements: readonly InkElementV1[];
    readonly selectedPreviewIds: ReadonlySet<string>;
  } {
    if (preview.transform === null) return { elements: [], selectedPreviewIds: new Set() };
    if (!preview.exactPreviewTruncated) {
      return {
        elements: [],
        selectedPreviewIds: active.connectedPreview.selectedPreviewIds,
      };
    }
    return active.connectedPreview.update(preview.transform);
  }

  #selectedGeometry(): SelectedElementGeometry[] {
    const geometry: SelectedElementGeometry[] = [];
    for (const id of this.#selection()) {
      const record = this.#sceneStore.get(id);
      if (record !== undefined) geometry.push({ bounds: record.bounds, element: record.element });
    }
    return geometry;
  }
}

function handleSessionStart(handle: SelectionHandle): PointV1 {
  return handle.point;
}
