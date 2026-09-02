import { calculateElementBounds } from "../../../domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../domain/schema/public";
import type { SnappingSettingsV1 } from "../../../domain/settings/types";
import type { PointerSample } from "../../../editor/input/index";
import {
  connectedSelectionTransformPreview,
  exactConnectedSelectionIds,
  findSelectionHandle,
  layoutSelectionHandles,
  selectionOverlayGeometry,
  SelectionFrameSession,
  SelectionHandleSession,
  type SelectedElementGeometry,
  type OrientedSelectionFrame,
  type SelectionHandle,
  type SelectionHandlePreview,
} from "../../../editor/selection/public";
import type { EditableDocumentModel } from "../vault-document-session";

import { selectedElements } from "./controller-elements";
import type { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ElementSceneStore } from "./scene-store";
import { selectionHandleAction } from "./selection-handle-action";
import { activeSnapFeatures } from "./snapping-settings";
import { pressureStrokeScalePreview } from "./pressure-stroke-preview";
import { commitPreviewReplacement } from "./preview-replacement-commit";
import {
  pointerHandleRadiusPixels,
  SelectionHandlePresentation,
  type HandleInteractionRenderer,
} from "./handle-presentation";

export interface ActiveEditorHandleInteractionOptions {
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

interface ActiveHandleGesture {
  readonly grabOffset: PointV1;
  readonly ids: readonly string[];
  readonly pointerId: number;
  readonly pointerType: PointerSample["pointerType"];
  readonly pressureStrokeIds: ReadonlySet<string>;
  readonly selected: readonly SelectedElementGeometry[];
  readonly frame: OrientedSelectionFrame | null;
  readonly selectedIds: ReadonlySet<string>;
  readonly session: SelectionHandleSession;
  readonly snapping: SnappingSettingsV1 | undefined;
}

export class ActiveEditorHandleInteraction {
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
  #active: ActiveHandleGesture | undefined;
  #previewMaximumBottom: number | undefined;

  public constructor(options: ActiveEditorHandleInteractionOptions) {
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

  public cancel(pointerId?: number): boolean {
    const active = this.#active;
    if (active === undefined || (pointerId !== undefined && active.pointerId !== pointerId)) {
      return false;
    }
    active.session.cancel();
    this.#layout?.finish(false);
    this.#finish();
    return true;
  }

  public dispose(): void {
    this.cancel();
    this.#presentation.dispose();
  }

  public pointerDown(
    pointer: PointerSample,
    uniformScale = false,
    snappingInverted = false,
  ): boolean {
    if (this.#active !== undefined) return false;
    const selected = this.#selectedGeometry();
    const frame = this.#selectionFrames.current(selected);
    const handles = layoutSelectionHandles(selected, { frame, zoom: this.#zoom() });
    const handle = findSelectionHandle(
      handles,
      pointer,
      this.#zoom(),
      pointerHandleRadiusPixels(selected, frame, pointer, this.#zoom()),
    );
    if (handle === null) return false;
    const elements = selected.map(({ element }) => element);
    const selectedIds = new Set(elements.map(({ id }) => id));
    const action = selectionHandleAction(handle, selected, frame);
    const sessionStart = handleSessionStart(handle);
    const configuredSnapping = this.#snapping();
    const snapping =
      configuredSnapping === undefined ? undefined : structuredClone(configuredSnapping);
    this.#active = {
      ids: elements.map(({ id }) => id),
      frame,
      grabOffset: {
        x: pointer.x - sessionStart.x,
        y: pointer.y - sessionStart.y,
      },
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      pressureStrokeIds: new Set(
        elements
          .filter((element) => element.kind === "stroke" && element.style.pressureEnabled)
          .map(({ id }) => id),
      ),
      selected,
      selectedIds,
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
    const pressure = pressureStrokeScalePreview(active.selected, active.pressureStrokeIds, preview);
    this.#updatePreviewBottom(active, preview, connected.elements);
    this.#presentation.renderTransform(
      active.ids.filter(
        (id) => !connected.selectedPreviewIds.has(id) && !pressure.exactPreviewIds.has(id),
      ),
      preview.transform,
    );
    this.#presentation.renderPreview(active, preview, connected, pressure.elements);
    return true;
  }

  public pointerUp(pointerId: number): boolean {
    const active = this.#active;
    if (active === undefined || active.pointerId !== pointerId) return false;
    const commit = active.session.prepareCommit();
    const effect = this.#selectionFrames.transition(active.frame, active.session.preview.transform);
    if (commit.status === "ready") {
      const committed = commitPreviewReplacement({
        effect,
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
        effect,
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
    this.#presentation.renderGeometry(
      selected,
      null,
      null,
      this.#selectionFrames.current(selected),
    );
  }

  #finish(): void {
    this.#active = undefined;
    this.#previewMaximumBottom = undefined;
    this.#model.setGestureActive(false);
    this.#presentation.clearPreviews();
    this.renderSelection();
  }

  #updatePreviewBottom(
    active: ActiveHandleGesture,
    preview: SelectionHandlePreview,
    connectedElements: readonly InkElementV1[],
  ): void {
    let maximumBottom = Number.NEGATIVE_INFINITY;
    for (const element of preview.exactElements) {
      maximumBottom = Math.max(maximumBottom, calculateElementBounds(element).maxY);
    }
    for (const element of connectedElements) {
      maximumBottom = Math.max(maximumBottom, calculateElementBounds(element).maxY);
    }
    if (preview.transform !== null) {
      const outline = selectionOverlayGeometry(
        active.selected,
        this.#zoom(),
        preview.transform,
        active.frame,
      )?.outline;
      if (outline?.kind === "linear") {
        maximumBottom = Math.max(
          maximumBottom,
          outline.start.y,
          outline.end.y,
          outline.bend?.y ?? Number.NEGATIVE_INFINITY,
        );
      } else if (outline !== undefined) {
        for (const point of outline.points) maximumBottom = Math.max(maximumBottom, point.y);
      }
    }
    if (!Number.isFinite(maximumBottom)) return;
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
        selectedPreviewIds: exactConnectedSelectionIds(preview.exactElements, active.selectedIds),
      };
    }
    return connectedSelectionTransformPreview(
      this.#model.store,
      active.selected.map(({ element }) => element),
      active.selectedIds,
      preview.transform,
    );
  }

  #selectedGeometry(): SelectedElementGeometry[] {
    const selected = selectedElements(this.#sceneStore, this.#selection());
    const geometry: SelectedElementGeometry[] = [];
    for (const element of selected) {
      const bounds = this.#sceneStore.get(element.id)?.bounds;
      if (bounds !== undefined) geometry.push({ bounds, element });
    }
    return geometry;
  }
}

function handleSessionStart(handle: SelectionHandle): PointV1 {
  return handle.point;
}
