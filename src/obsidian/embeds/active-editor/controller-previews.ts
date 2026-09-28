import type { InkbookFeedbackCode } from "../../feedback/feedback-catalog";
import type { SnappingSettingsV1, ToolDefaultsV1 } from "../../../domain/settings/types";
import { screenPixelsToPageUnits, type GesturePreviewStart } from "../../../editor/gestures/public";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import { CreationPreview } from "./creation-preview";
import { EraserPreview } from "./eraser-preview";
import { ActiveEditorHistory } from "./history";
import type { PreparedElementHistory } from "./prepared-element-history";
import { LassoPreview, MovePreview, type SelectionEdgeDragPort } from "./selection-preview";
import type { ElementSceneStore } from "./scene-store";
import type { EditableDocumentModel } from "../vault-document-session";
import type { PointV1 } from "../../../domain/schema/public";
import type { SelectionFrameSession } from "../../../editor/selection/public";
import { activeSnapFeatures } from "./snapping-settings";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

export interface ActiveEditorPreviewOptions {
  readonly defaults: ToolDefaultsV1;
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly ownerWindow: Window;
  readonly workScheduler: WorkScheduler;
  readonly onFeedback?: (code: InkbookFeedbackCode) => void;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly pageToViewport?: (point: PointV1) => PointV1;
  readonly viewportToPage?: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: SvgSceneRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selection: () => ReadonlySet<string>;
  readonly selectionSignal?: AbortSignal;
  readonly selectionFrames: SelectionFrameSession;
  readonly selectionEdgeDrag?: SelectionEdgeDragPort;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly snapping?: SnappingSettingsV1;
  readonly snappingInverted?: () => boolean;
  readonly zoom?: () => number;
}

export function createActiveEditorPreview(
  start: GesturePreviewStart,
  options: ActiveEditorPreviewOptions,
) {
  if (start.kind === "eraser-gesture") {
    const zoom = previewZoom(options);
    return new EraserPreview({
      history: options.history,
      model: options.model,
      workScheduler: options.workScheduler,
      radius: screenPixelsToPageUnits(options.defaults.eraser.radius, zoom),
      renderer: options.renderer,
      sceneStore: options.sceneStore,
      start,
    });
  }
  const snapFeatures = () =>
    activeSnapFeatures(options.snapping, options.snappingInverted?.() ?? false);
  const selectionOptions = {
    ...(options.selectionSignal === undefined ? {} : { selectionSignal: options.selectionSignal }),
    connectionSnapping: () => snapFeatures().connections,
    frameScheduler: options.workScheduler,
    workScheduler: options.workScheduler,
    history: options.history,
    pageToScreen: options.pageToScreen,
    ...(options.pageToViewport === undefined ? {} : { pageToViewport: options.pageToViewport }),
    ...(options.viewportToPage === undefined ? {} : { viewportToPage: options.viewportToPage }),
    preparedHistory: options.preparedHistory,
    renderer: options.renderer,
    sceneStore: options.sceneStore,
    selection: options.selection,
    selectionFrames: options.selectionFrames,
    selectionDefaults: structuredClone(options.defaults.select),
    ...(options.selectionEdgeDrag === undefined
      ? {}
      : { selectionEdgeDrag: options.selectionEdgeDrag }),
    setSelection: options.setSelection,
    start,
    store: options.model.store,
    zoom: () => previewZoom(options),
  };
  if (start.kind === "lasso") {
    return new LassoPreview(selectionOptions);
  }
  if (start.kind === "element-move") {
    return new MovePreview(selectionOptions);
  }
  const zoom = previewZoom(options);
  return new CreationPreview({
    now: () => options.ownerWindow.performance.now(),
    onStrokeCapacityReached: () => options.onFeedback?.("stroke-point-limit-reached"),
    defaults: options.defaults,
    history: options.history,
    identity: { createdAt: Date.now(), id: options.ownerWindow.crypto.randomUUID() },
    renderer: options.renderer,
    snap: {
      angles: () => snapFeatures().angles,
      connections: () => snapFeatures().connections,
      pageToScreen: options.pageToScreen,
      spatial: { query: (bounds, sink) => options.sceneStore.query(bounds, sink) },
      targets: {
        get: (id) => options.sceneStore.getSnapTarget(id),
      },
      zoom,
    },
    start,
    strokeInput: {
      pressureSource:
        start.tool === "draw" && start.pointer.pointerType === "pen" ? "pen" : "simulated",
      zoom,
    },
  });
}

function previewZoom(options: ActiveEditorPreviewOptions): number {
  const configured = options.zoom?.();
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) return configured;
  const origin = options.pageToScreen({ x: 0, y: 0 });
  const unit = options.pageToScreen({ x: 1, y: 0 });
  const inferred = Math.hypot(unit.x - origin.x, unit.y - origin.y);
  return Number.isFinite(inferred) && inferred > 0 ? inferred : 1;
}
