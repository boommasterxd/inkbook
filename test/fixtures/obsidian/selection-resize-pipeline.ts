import type { InkElementV1, PageV1, PointV1 } from "../../../src/domain/schema/public";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import { FakeDocument, FakeNode, FakeScheduler, asElement } from "../../unit/rendering/scene/fakes";

export interface ResizeApi {
  calculateElementBounds: typeof import("../../../src/domain/geometry/public").calculateElementBounds;
  derivePageExtent: typeof import("../../../src/domain/geometry/public").derivePageExtent;
  layoutSelectionHandles: typeof import("../../../src/editor/selection/public").layoutSelectionHandles;
  ElementStore: typeof import("../../../src/domain/store/public").ElementStore;
  ElementSceneStore: typeof import("../../../src/obsidian/embeds/active-editor/scene-store").ElementSceneStore;
  SvgSceneRenderer: typeof import("../../../src/rendering/scene/index").SvgSceneRenderer;
  ActiveEditorHandleInteraction: typeof import("../../../src/obsidian/embeds/active-editor/handle-interaction").ActiveEditorHandleInteraction;
  ActiveEditorHistory: typeof import("../../../src/obsidian/embeds/active-editor/history").ActiveEditorHistory;
  MovePreview: typeof import("../../../src/obsidian/embeds/active-editor/move-preview").MovePreview;
}
export const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

export function createPipeline(
  api: ResizeApi,
  elements: readonly InkElementV1[],
  pageHeight: number,
) {
  const store = new api.ElementStore(elements);
  const sceneStore = new api.ElementSceneStore(store);
  const scheduler = new FakeScheduler();
  const document = new FakeDocument();
  const renderer = new api.SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 120, left: 0, top: 0, width: 120 }) },
    page: PAGE,
    reducedMotion: true,
    scheduler,
    store: sceneStore,
  });
  renderer.setPage(PAGE, pageHeight);
  scheduler.runAll();
  return { renderer, sceneStore, scheduler, store };
}

export function createInteraction(
  api: ResizeApi,
  fixture: ReturnType<typeof createPipeline>,
  elements: readonly InkElementV1[],
  updateBottom: (maximumBottom: number) => void,
) {
  const ports = interactionPorts(api, fixture, elements);
  return new api.ActiveEditorHandleInteraction({
    frameScheduler: fixture.scheduler,
    layout: { begin: () => undefined, finish: () => undefined, updateBottom },
    ...ports,
    preparedHistory: {} as never,
    renderer: fixture.renderer,
    zoom: () => 1,
  });
}

export function interactionPorts(
  api: ResizeApi,
  fixture: ReturnType<typeof createPipeline>,
  elements: readonly InkElementV1[],
) {
  const model = {
    setGestureActive: () => undefined,
    store: fixture.store,
  } as unknown as EditableDocumentModel;
  return {
    history: new api.ActiveEditorHistory(model),
    model,
    pageToScreen: (point: PointV1) => point,
    sceneStore: fixture.sceneStore,
    selection: () => new Set(elements.map(({ id }) => id)),
  };
}

export function resizeHandle(api: ResizeApi, elements: readonly InkElementV1[]): PointV1 {
  const selected = elements.map((element) => ({
    bounds: api.calculateElementBounds(element),
    element,
  }));
  const handle = api
    .layoutSelectionHandles(selected, { zoom: 1 })
    .find((candidate) => candidate.kind === "scale" && candidate.position === "bottom-right");
  if (handle?.kind !== "scale") throw new TypeError("Expected a scale handle.");
  return handle.point;
}

export function pointerAt(start: PointV1, frame: number, sample: number) {
  const progress = frame * 4 + sample + 1;
  return {
    pointerId: 1,
    pointerType: "mouse" as const,
    pressure: 0,
    x: start.x + 30 + progress * 0.02,
    y: start.y + 80 + progress * 0.25,
  };
}

export function maximumBottom(api: ResizeApi, elements: readonly InkElementV1[]): number | null {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    maximum = Math.max(maximum, api.calculateElementBounds(element).maxY);
  }
  return Number.isFinite(maximum) ? maximum : null;
}

export function createMovePreview(
  api: ResizeApi,
  fixture: ReturnType<typeof createPipeline>,
  elements: readonly InkElementV1[],
  updatePreviewBottom: () => void,
) {
  return new api.MovePreview({
    frameScheduler: fixture.scheduler,
    ...interactionPorts(api, fixture, elements),
    preparedHistory: {} as never,
    renderer: fixture.renderer,
    selectionEdgeDrag: {
      begin: () => undefined,
      finish: () => undefined,
      stop: () => undefined,
      update: () => undefined,
      updatePreviewBottom,
    },
    setSelection: () => undefined,
    start: {
      additive: false,
      kind: "element-move",
      pointer: { pointerId: 2, pointerType: "pen", pressure: 0.5, x: 100, y: 100 },
      tool: "select",
    },
    store: fixture.store,
    zoom: () => 1,
  });
}
