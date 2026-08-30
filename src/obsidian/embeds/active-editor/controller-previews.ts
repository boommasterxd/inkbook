import type { ToolDefaultsV1 } from "../../../domain/settings/types";
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

export interface ActiveEditorPreviewOptions {
  readonly defaults: ToolDefaultsV1;
  readonly history: ActiveEditorHistory;
  readonly model: EditableDocumentModel;
  readonly ownerWindow: Window;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly pageToViewport?: (point: PointV1) => PointV1;
  readonly viewportToPage?: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: SvgSceneRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly sliceBudgetMs: () => number;
  readonly selection: () => ReadonlySet<string>;
  readonly selectionEdgeDrag?: SelectionEdgeDragPort;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
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
      ownerWindow: options.ownerWindow,
      radius: screenPixelsToPageUnits(options.defaults.eraser.radius, zoom),
      renderer: options.renderer,
      sceneStore: options.sceneStore,
      sliceBudgetMs: options.sliceBudgetMs,
      start,
    });
  }
  const selectionOptions = {
    history: options.history,
    pageToScreen: options.pageToScreen,
    ...(options.pageToViewport === undefined ? {} : { pageToViewport: options.pageToViewport }),
    ...(options.viewportToPage === undefined ? {} : { viewportToPage: options.viewportToPage }),
    preparedHistory: options.preparedHistory,
    renderer: options.renderer,
    sceneStore: options.sceneStore,
    selection: options.selection,
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
    defaults: options.defaults,
    history: options.history,
    identity: { createdAt: Date.now(), id: options.ownerWindow.crypto.randomUUID() },
    renderer: options.renderer,
    snap: {
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
