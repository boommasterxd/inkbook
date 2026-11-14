import type { InkbookFeedbackCode } from "../../../feedback/feedback-catalog";
import type {
  HoldToShapeSettingsV1,
  SnappingSettingsV1,
  ToolDefaultsV1,
} from "../../../../domain/settings/types";
import {
  screenPixelsToPageUnits,
  type GesturePreviewStart,
} from "../../../../editor/gestures/public";
import type { SvgSceneRenderer } from "../../../../rendering/scene/index";
import { CreationPreview } from "./creation-preview";
import { EraserPreview } from "./eraser-preview";
import { ActiveEditorHistory } from "../history";
import type { PreparedElementHistory } from "../prepared-element-history";
import { LassoPreview, MovePreview, type SelectionEdgeDragPort } from "./selection-preview";
import type { ElementSceneStore } from "../scene-store";
import type { EditableDocumentModel } from "../../document-session/vault-document-session";
import type { PointV1 } from "../../../../domain/schema/public";
import type {
  SelectionFrameSession,
  SelectedElementGeometry,
} from "../../../../editor/selection/public";
import { activeSnapFeatures } from "./snapping-settings";
import { TextCreationPreview, type TextCreationBox } from "./text-creation-preview";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";

export interface ActiveEditorPreviewOptions {
  readonly createText?: (box: TextCreationBox) => void;
  readonly defaults: ToolDefaultsV1;
  readonly holdToShape?: HoldToShapeSettingsV1;
  readonly screenStart?: PointV1;
  readonly isCurrent?: () => boolean;
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
  readonly selectionGeometry?: () => readonly SelectedElementGeometry[];
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
  if (start.tool === "text" && start.kind === "tool-gesture") {
    if (options.createText === undefined) throw new Error("Text creation is unavailable.");
    return new TextCreationPreview({
      start,
      defaults: options.defaults.text,
      renderer: options.renderer,
      create: options.createText,
    });
  }
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
  const snapFeatures = (toolEnabled = true) =>
    activeSnapFeatures(options.snapping, options.snappingInverted?.() ?? false, toolEnabled);
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
    ...(options.selectionGeometry === undefined
      ? {}
      : { selectionGeometry: options.selectionGeometry }),
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
  const toolSnapping =
    start.tool === "line"
      ? options.defaults.line.snappingEnabled
      : start.tool === "arrow"
        ? options.defaults.arrow.snappingEnabled
        : true;
  return new CreationPreview({
    ...(options.holdToShape === undefined ? {} : { holdToShape: options.holdToShape }),
    ownerWindow: options.ownerWindow,
    ...(options.screenStart === undefined ? {} : { screenStart: options.screenStart }),
    now: () => options.ownerWindow.performance.now(),
    onStrokeCapacityReached: () => options.onFeedback?.("stroke-point-limit-reached"),
    defaults: options.defaults,
    history: options.history,
    ...(options.isCurrent === undefined ? {} : { isCurrent: options.isCurrent }),
    model: options.model,
    readRevision: () => options.model.revision,
    ...(options.selectionSignal === undefined ? {} : { refinementSignal: options.selectionSignal }),
    workScheduler: options.workScheduler,
    identity: { createdAt: Date.now(), id: options.ownerWindow.crypto.randomUUID() },
    renderer: options.renderer,
    snap: {
      angles: () => snapFeatures(toolSnapping).angles,
      connections: () => snapFeatures(toolSnapping).connections,
      pageToScreen: options.pageToScreen,
      spatial: options.sceneStore,
      targets: {
        get: (id, bounds) => options.sceneStore.getSnapTarget(id, bounds),
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
