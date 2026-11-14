import type { InkElementV1, TextElementV2 } from "../../../../domain/schema/public";
import type { SnappingSettingsV1 } from "../../../../domain/settings/types";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";
import type { ToolSystemCursor } from "../../../../editor/input/tool-cursor";
import type { PointerSample } from "../../../../editor/input/index";
import {
  ConnectedSelectionPreviewSession,
  HitTestScratch,
  selectionOverlayGeometry,
  type SelectionOverlayGeometry,
  SelectionFrameSession,
  SelectionHandleSession,
  type SelectedElementGeometry,
  type ConnectedSelectionPreview,
  type OrientedSelectionFrame,
  type SelectionHandlePreview,
  type SelectionHandle,
} from "../../../../editor/selection/public";
import type { EditableDocumentModel } from "../../document-session/vault-document-session";
import {
  selectionCursorAt,
  preferredSelectionHandle,
  selectionCursorHandle,
  selectionHandleCursor,
} from "./selection-cursor";
import type { ActiveEditorHistory } from "../history";
import type { PreparedElementHistory } from "../prepared-element-history";
import type { ElementSceneStore } from "../scene-store";
import { selectionHandleAction } from "./selection-handle-action";
import { activeSnapFeatures } from "./snapping-settings";
import { commitHandlePreview, type ActiveHandleGesture } from "./handle-preview-commit";
import { SelectionScalePreviewPlan } from "./selection-scale-preview";
import { SelectionHandlePresentation, type HandleInteractionRenderer } from "./handle-presentation";
import { ConnectionPreviewPreparation } from "./connection-preview-preparation";
import type { SelectionPreviewFrameScheduler } from "./selection-preview-contracts";
import { subscribeSelectionHandleRefresh } from "./selection-handle-refresh";
import type { ActiveEditorHandleInteractionOptions } from "./handle-interaction-contracts";
import { TextEditingFrame } from "./text-editing-frame";
export type { ActiveEditorHandleInteractionOptions } from "./handle-interaction-contracts";
export type { HandleInteractionRenderer } from "./handle-presentation";
export type HandleFrameScheduler = SelectionPreviewFrameScheduler;
interface PendingHandleSample {
  readonly pointer: PointerSample;
  readonly snappingInverted: boolean;
  readonly uniformScale: boolean;
}
export class ActiveEditorHandleInteraction {
  readonly #editingFrame = new TextEditingFrame();
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
  readonly #workScheduler: WorkScheduler | undefined;
  readonly #reflowText: ActiveEditorHandleInteractionOptions["reflowText"];
  readonly #onGestureSettled: (() => void) | undefined;
  #connectionPreparation: ConnectionPreviewPreparation | undefined;
  #lastSample: PendingHandleSample | undefined;
  readonly #unsubscribeStore: () => void;
  #geometrySelection: ReadonlySet<string> | undefined;
  #geometryRevision = -1;
  #geometrySelectionSize = -1;
  #geometrySnapshot: readonly SelectedElementGeometry[] = [];
  #renderedSelection: ReadonlySet<string> | undefined;
  #renderedRevision = -1;
  #renderedSelectionSize = -1;
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
  #disposed = false;
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
      (selected) => this.#editingFrame.preview(selected),
    );
    this.#sceneStore = options.sceneStore;
    this.#selectionFrames = options.selectionFrames ?? new SelectionFrameSession();
    this.#selection = options.selection;
    this.#snapping = options.snapping ?? (() => undefined);
    this.#zoom = options.zoom;
    this.#workScheduler = options.workScheduler;
    this.#reflowText = options.reflowText;
    this.#onGestureSettled = options.onGestureSettled;
    this.#unsubscribeStore = subscribeSelectionHandleRefresh(
      options,
      () => {
        this.#geometrySelection = undefined;
        this.#renderedRevision = -1;
        return this.#active === undefined;
      },
      () => this.renderCameraSelection(),
    );
  }
  public get activePointerId(): number | undefined {
    return this.#active?.pointerId;
  }
  public setTextEditingHeight(id: string, height: number | undefined, basis?: TextElementV2): void {
    if (this.#disposed || !this.#editingFrame.set(id, height, basis)) return;
    if (this.#active) this.#renderActivePreview(this.#active, this.#active.session.preview);
    else this.renderSelection();
  }
  public setKeyboardFocus(index: number | null): void {
    if (this.#presentation.keyboardFocus === index) return;
    this.#presentation.keyboardFocus = index;
    this.renderSelection();
  }
  public get activePointerType(): PointerSample["pointerType"] | undefined {
    return this.#active?.pointerType;
  }
  public cursorAt(pointer: PointerSample, visualOnly?: boolean): ToolSystemCursor | undefined {
    if (this.#active !== undefined) return this.#active.cursor;
    return selectionCursorAt(this.#cursorGeometry, pointer, {
      zoom: this.#zoom(),
      rotation: this.#cursorRotation,
      linear: this.#cursorLinear,
      hit: this.#cursorLinearHit,
      selected: this.#geometrySnapshot,
      ...(visualOnly === undefined ? {} : { handlesOnly: true, visualOnly }),
    });
  }
  public cancel(pointerId?: number): boolean {
    const active = this.#active;
    if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return false;
    this.#discardPendingSample();
    active.session.cancel();
    this.#layout?.finish(false);
    this.#finish();
    return true;
  }
  public dispose(): void {
    this.#disposed = true;
    this.cancel();
    this.#unsubscribeStore();
    this.#geometrySelection = undefined;
    this.#geometrySnapshot = [];
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
    preferredHandle?: SelectionHandle,
  ): boolean {
    if (this.#active !== undefined) return false;
    const selected = this.selectionGeometry();
    const frame = this.#editingFrame.resolve(selected, this.#selectionFrames);
    this.#cacheCursorGeometry(selected, frame);
    const handles = this.#cursorGeometry?.handles ?? [];
    const handle = preferredHandle
      ? preferredSelectionHandle(handles, preferredHandle)
      : selectionCursorHandle(this.#cursorGeometry, pointer, this.#zoom(), selected);
    if (handle === null) return false;
    const elements = selected.map(({ element }) => element);
    const selectedIds = new Set(elements.map(({ id }) => id));
    const action = selectionHandleAction(handle, selected, frame);
    const configuredSnapping = this.#snapping();
    const snapping =
      configuredSnapping === undefined ? undefined : structuredClone(configuredSnapping);
    const ids = elements.map(({ id }) => id);
    const connectedPreview = new ConnectedSelectionPreviewSession(
      this.#model.store,
      action.kind === "table-header" || action.kind === "table-column" ? [] : elements,
      selectedIds,
    );
    const scalePreview = new SelectionScalePreviewPlan(selected);
    const connectedTransformIds = ids.filter((id) => !connectedPreview.selectedPreviewIds.has(id));
    this.#active = {
      selectionSource: this.#selection(),
      cursor:
        handle.kind === "rotate" ? "grabbing" : selectionHandleCursor(handle, this.#cursorRotation),
      connectedPreview,
      connectedTransformIds,
      frame,
      grabOffset: {
        x: pointer.x - handle.point.x,
        y: pointer.y - handle.point.y,
      },
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      selected,
      selectedIds,
      scalePreview,
      snapping,
      session: new SelectionHandleSession({
        onPreviewReady: (preview) => {
          const active = this.#active;
          if (active?.session.preview === preview) this.#renderActivePreview(active, preview);
        },
        action,
        elements,
        planner: this.#model.store,
        requiresConnectionPreparation: () => connectedPreview.requiresPreparation,
        preparedFrame: frame,
        snap: {
          ...(this.#workScheduler === undefined ? {} : { scheduler: this.#workScheduler }),
          canConnect: (sourceId, targetId) => this.#sceneStore.canConnect(sourceId, targetId),
          features: activeSnapFeatures(snapping, snappingInverted),
          pointerType: pointer.pointerType,
          spatial: this.#sceneStore,
          targets: {
            get: (id, bounds) => this.#sceneStore.getSnapTarget(id, bounds),
          },
          zoom: this.#zoom(),
        },
        startPointer: handle.point,
        uniformScale,
        ...(this.#reflowText === undefined ? {} : { reflowText: this.#reflowText }),
      }),
    };
    this.#model.setGestureActive(true);
    this.#previewMaximumBottom = undefined;
    this.#layout?.begin();
    const refreshConnections = () => {
      const sample = this.#lastSample;
      if (sample !== undefined && this.#active?.connectedPreview === connectedPreview)
        this.pointerMove(sample.pointer, sample.uniformScale, sample.snappingInverted);
    };
    this.#connectionPreparation = new ConnectionPreviewPreparation(
      {
        store: this.#model.store,
        sceneStore: this.#sceneStore,
        ...(this.#workScheduler === undefined ? {} : { scheduler: this.#workScheduler }),
      },
      elements.length === 1 ? elements[0] : undefined,
      refreshConnections,
    );
    this.#connectionPreparation.prepareConnected(connectedPreview, refreshConnections);
    return true;
  }
  public hitHandle(pointer: PointerSample, visualOnly = false): SelectionHandle | null {
    const selected = this.selectionGeometry();
    const frame = this.#editingFrame.resolve(selected, this.#selectionFrames);
    this.#cacheCursorGeometry(selected, frame);
    return selectionCursorHandle(this.#cursorGeometry, pointer, this.#zoom(), selected, visualOnly);
  }
  public pointerMove(
    pointer: PointerSample,
    uniformScale = false,
    snappingInverted = false,
  ): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointer.pointerId) return false;
    this.#pendingSample = { pointer, snappingInverted, uniformScale };
    this.#lastSample = this.#pendingSample;
    this.#connectionPreparation?.ensure();
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
    this.#renderActivePreview(active, preview);
  }
  #renderActivePreview(active: ActiveHandleGesture, preview: SelectionHandlePreview): void {
    const retainedTextIds = active.scalePreview.retainedTextIds(preview);
    const materializeScale = active.session.createScalePreviewMaterializer();
    const scaleMaterializer =
      materializeScale === undefined
        ? undefined
        : active.scalePreview.materializer(materializeScale);
    const connected = this.#connectedPreview(active, preview, scaleMaterializer);
    const scale = active.scalePreview.resolve(preview);
    if (preview.transform?.kind !== "scale" && connected.progressive === undefined) {
      this.#renderer.clearProgressiveElementPreviews?.();
    }
    this.#presentation.renderTransform(
      active.scalePreview.transformIds(preview, active.connectedTransformIds),
      preview.transform,
      preview.textScaleBasis,
    );
    this.#updatePreviewBottom(
      this.#presentation.renderPreview(active, preview, connected, scale.elements),
    );
    if (preview.transform?.kind === "scale" && scaleMaterializer !== undefined) {
      this.#presentation.renderProgressive(
        active.connectedTransformIds,
        scaleMaterializer,
        preview.transform,
        connected.progressive ?? (retainedTextIds ? "connected" : undefined),
        connected.elements.length === 0 && connected.selectedPreviewIds.size === 0
          ? active.selectionSource
          : undefined,
      );
    }
    this.#renderer.flushPointerFeedbackFrame();
  }
  public pointerUp(pointerId: number): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointerId) return false;
    let prepared = false;
    let releaseConnectedPreview: (() => void) | undefined;
    let layoutFinished = false;
    const finishLayout = (committed: boolean, maximumBottom?: number) => {
      if (layoutFinished) return;
      layoutFinished = true;
      this.#layout?.finish(committed, maximumBottom);
    };
    try {
      this.#cancelPointerFrame();
      this.#applyPendingSample(active);
      releaseConnectedPreview = this.#connectionPreparation?.retainPreview();
      this.#connectionPreparation = undefined;
      prepared = commitHandlePreview(
        {
          active,
          history: this.#history,
          layout: { finish: finishLayout },
          preparedHistory: this.#preparedHistory,
          renderer: this.#renderer,
          selectionFrames: this.#selectionFrames,
          previewMaximumBottom: this.#previewMaximumBottom,
        },
        () => {
          try {
            releaseConnectedPreview?.();
          } finally {
            if (!this.#disposed) this.renderCameraSelection();
            this.#onGestureSettled?.();
          }
        },
      );
      return true;
    } catch (error: unknown) {
      finishLayout(false);
      throw error;
    } finally {
      if (!prepared) releaseConnectedPreview?.();
      this.#finish(prepared);
    }
  }
  public renderSelection(): void {
    if (this.#active !== undefined) return;
    const selected = this.selectionGeometry();
    const frame = this.#editingFrame.resolve(selected, this.#selectionFrames);
    this.#cacheCursorGeometry(selected, frame);
    this.#renderedSelection = this.#selection();
    this.#renderedSelectionSize = this.#renderedSelection.size;
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
      this.#renderedSelectionSize !== this.#selection().size ||
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
  #finish(retainOverlay = false): void {
    this.#connectionPreparation?.dispose();
    this.#connectionPreparation = undefined;
    this.#lastSample = undefined;
    this.#discardPendingSample();
    this.#active = undefined;
    this.#previewMaximumBottom = undefined;
    this.#model.setGestureActive(false);
    this.#presentation.clearPreviews();
    if (!retainOverlay) this.renderCameraSelection();
    if (!retainOverlay) this.#onGestureSettled?.();
  }
  #schedulePointerFrame(active: ActiveHandleGesture): void {
    if (this.#frameHandle !== undefined) return;
    let completedSynchronously = false;
    let handle = 0;
    handle = this.#frameScheduler.requestFrame(() => {
      completedSynchronously = true;
      if (this.#frameHandle === handle) this.#frameHandle = undefined;
      if (this.#active === active) this.#applyPendingSample(active);
    }, "input");
    if (!completedSynchronously) this.#frameHandle = handle;
  }
  #discardPendingSample(): void {
    this.#cancelPointerFrame();
    this.#pendingSample = undefined;
  }
  #cancelPointerFrame(): void {
    if (this.#frameHandle === undefined) return;
    this.#frameScheduler.cancelFrame(this.#frameHandle);
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
    materializeRoot: ((id: string) => InkElementV1 | undefined) | undefined,
  ): ConnectedSelectionPreview {
    if (preview.transform === null) {
      return preview.exactPreviewTruncated
        ? active.connectedPreview.updateTargets(preview.exactElements)
        : { elements: [], selectedPreviewIds: new Set() };
    }
    if (!preview.exactPreviewTruncated) {
      return {
        elements: [],
        selectedPreviewIds: active.connectedPreview.selectedPreviewIds,
      };
    }
    return active.connectedPreview.update(preview.transform, materializeRoot);
  }
  public selectionGeometry(): readonly SelectedElementGeometry[] {
    const selection = this.#selection();
    if (
      this.#geometrySelection === selection &&
      this.#geometrySelectionSize === selection.size &&
      this.#geometryRevision === this.#model.revision
    ) {
      return this.#geometrySnapshot;
    }
    const geometry: SelectedElementGeometry[] = [];
    for (const id of selection) {
      const record = this.#sceneStore.get(id);
      if (record !== undefined) geometry.push({ bounds: record.bounds, element: record.element });
    }
    this.#geometrySelection = selection;
    this.#geometrySelectionSize = selection.size;
    this.#geometryRevision = this.#model.revision;
    this.#geometrySnapshot = geometry;
    return this.#geometrySnapshot;
  }
}
