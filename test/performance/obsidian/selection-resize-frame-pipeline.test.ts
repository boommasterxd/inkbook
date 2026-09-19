import { afterEach, describe, expect, it, vi } from "vitest";

import * as elementPath from "../../../src/domain/geometry/element-path";
import { ProgressivePreviewPath } from "../../../src/rendering/scene/progressive-preview-path";

import { calculateElementBounds, derivePageExtent } from "../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { layoutSelectionHandles } from "../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { MovePreview } from "../../../src/obsidian/embeds/active-editor/move-preview";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { SvgSceneRenderer } from "../../../src/rendering/scene";
import { INTERACTION_REFRESH_PROFILE, runInteractionFrames } from "../interaction-refresh-profile";
import type { StrokeElementV1, PageV1, PointV1 } from "../../../src/domain/schema/public";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { coordinateSystem, table } from "../../unit/domain/geometry/fixtures";
import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";
import { maximumStroke } from "../editor/maximum-stroke-fixture";
import { FakeDocument, FakeNode, FakeScheduler, asElement } from "../../unit/rendering/scene/fakes";

function mixedExactElements(): readonly InkElementV1[] {
  const stroke = maximumStroke(0);
  return mixedElements({
    ...stroke,
    points: stroke.points.slice(0, 256 * 3),
  });
}

function longPressureElements(): readonly InkElementV1[] {
  return mixedElements(maximumStroke(0));
}

function variablePressureElements(): readonly InkElementV1[] {
  const stroke = maximumStroke(0);
  return mixedElements({
    ...stroke,
    points: stroke.points.map((value, index) =>
      index % 3 === 2 ? Math.round((Math.sin(index / 60) + 1) * 5_000) / 10_000 : value,
    ),
  });
}

function pressureBandSelection(): readonly InkElementV1[] {
  return Array.from({ length: 40 }, (_, index) => {
    const x = 20 + (index % 8) * 12;
    const y = 20 + Math.floor(index / 8) * 12;
    return {
      ...indexedStroke(index),
      pivot: { x: x + 1.495, y },
      points: Array.from({ length: 300 }, (_, sample) => [
        Math.round((x + sample * 0.01) * 1_000) / 1_000,
        y,
        Math.round((Math.floor(sample / 20) / 14) * 10_000) / 10_000,
      ]).flat(),
    };
  });
}

function mixedElements(stroke: StrokeElementV1): readonly InkElementV1[] {
  const target = rectangle("30000000-0000-4000-8000-000000000001", 100, 100);
  const arrow = {
    ...connectedLine(target),
    endNode: "arrow" as const,
    id: "30000000-0000-4000-8000-000000000002",
    kind: "arrow" as const,
  };
  return [
    { ...stroke, id: "30000000-0000-4000-8000-000000000003" },
    target,
    arrow,
    { ...coordinateSystem(), id: "30000000-0000-4000-8000-000000000004" },
    { ...table(), id: "30000000-0000-4000-8000-000000000005" },
  ];
}

function fallbackElements(): readonly InkElementV1[] {
  return Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
}

function nonPressureStroke(index: number): StrokeElementV1 {
  const stroke = maximumStroke(index);
  return { ...stroke, style: { ...stroke.style, pressureEnabled: false } };
}

function mixedShapeFeedbackElements(): readonly InkElementV1[] {
  return [
    ...Array.from({ length: 255 }, (_, index) => ({
      ...rectangle(`40000000-0000-4000-8000-${String(index).padStart(12, "0")}`, 20, 20),
      rotation: 37,
    })),
    maximumStroke(0),
  ];
}

const RESIZE_WORKLOADS = [
  ["mixed exact resize", mixedExactElements],
  ["long pressure progressive resize", longPressureElements],
  ["4096-sample non-pressure resize", () => mixedElements(nonPressureStroke(0))],
  [
    "20,480-sample non-pressure progressive resize",
    () => Array.from({ length: 5 }, (_, index) => nonPressureStroke(index)),
  ],
  ["variable pressure progressive resize", variablePressureElements],
  ["40 long pressure strokes resize", pressureBandSelection],
  ["255 canonical shapes with a long pressure stroke", mixedShapeFeedbackElements],
  ["10,000-element progressive resize", fallbackElements],
] as const;

interface ResizeApi {
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
const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

function createPipeline(api: ResizeApi, elements: readonly InkElementV1[], pageHeight: number) {
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

function createInteraction(
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

function interactionPorts(
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

function resizeHandle(api: ResizeApi, elements: readonly InkElementV1[]): PointV1 {
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

function pointerAt(start: PointV1, frame: number, sample: number) {
  const progress = frame * 4 + sample + 1;
  return {
    pointerId: 1,
    pointerType: "mouse" as const,
    pressure: 0,
    x: start.x + 30 + progress * 0.02,
    y: start.y + 80 + progress * 0.25,
  };
}

function maximumBottom(api: ResizeApi, elements: readonly InkElementV1[]): number | null {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    maximum = Math.max(maximum, api.calculateElementBounds(element).maxY);
  }
  return Number.isFinite(maximum) ? maximum : null;
}

function createMovePreview(
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

const API: ResizeApi = {
  calculateElementBounds,
  derivePageExtent,
  layoutSelectionHandles,
  ElementStore,
  ActiveEditorHandleInteraction,
  ActiveEditorHistory,
  MovePreview,
  ElementSceneStore,
  SvgSceneRenderer,
};
const RAW_SAMPLES_PER_FRAME = 4;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz selection resize frame pipeline`, () => {
  afterEach(() => vi.restoreAllMocks());
  // Each independent workload retains its own default test deadline and scheduled work bound.
  it.for(RESIZE_WORKLOADS)(
    "keeps %s pointer-to-scene frames with coalesced work",
    ([, createElements]) => {
      const result = runResizePipeline(createElements());
      expect(result.layoutUpdates).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
      expect(result.pageGrowths).toBeGreaterThan(0);
    },
  );

  it("keeps coalesced S Pen selection moves with coalesced work", () => {
    const profiles = [
      ["mixed connected S Pen move", longPressureElements()],
      ["10,000-stroke S Pen move", fallbackElements()],
    ] as const;
    for (const [, elements] of profiles) {
      const result = runMovePipeline(elements);
      expect(result.layoutUpdates).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    }
  });
});

function runMovePipeline(elements: readonly InkElementV1[]) {
  const fixture = createPipeline(
    API,
    elements,
    derivePageExtent(PAGE, maximumBottom(API, elements)).activeHeight,
  );
  let layoutUpdates = 0;
  const preview = createMovePreview(API, fixture, elements, () => {
    layoutUpdates += 1;
  });
  const samples = Array.from({ length: INTERACTION_REFRESH_PROFILE.sampleCount }, (_, frame) =>
    Array.from({ length: RAW_SAMPLES_PER_FRAME }, (_, sample) => {
      const progress = frame * RAW_SAMPLES_PER_FRAME + sample + 1;
      return [
        {
          pointerId: 2,
          pointerType: "pen" as const,
          pressure: 0.5,
          x: 100 + progress * 0.05,
          y: 100 + progress * 0.1,
        },
      ];
    }),
  );
  let incorrectlyQueuedFrames = 0;
  fixture.renderer.resetInstrumentation();
  runInteractionFrames((frame) => {
    for (const batch of samples[frame]!) preview.updateSamples(batch);
    if (!(fixture.scheduler.pendingCount <= 2)) incorrectlyQueuedFrames += 1;
    fixture.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    fixture.scheduler.runFrame();
  });
  expect(incorrectlyQueuedFrames).toBe(0);
  preview.revert();
  fixture.renderer.destroy();
  fixture.sceneStore.release();
  return { layoutUpdates };
}

function runResizePipeline(elements: readonly InkElementV1[]) {
  let pageHeight = derivePageExtent(PAGE, maximumBottom(API, elements)).activeHeight;
  const fixture = createPipeline(API, elements, pageHeight);
  let layoutUpdates = 0;
  let pageGrowths = 0;
  const interaction = createInteraction(API, fixture, elements, (maximumBottom) => {
    layoutUpdates += 1;
    const nextHeight = derivePageExtent(PAGE, maximumBottom).activeHeight;
    if (nextHeight <= pageHeight) return;
    pageHeight = nextHeight;
    pageGrowths += 1;
    fixture.renderer.setPage(PAGE, pageHeight);
  });
  const start = resizeHandle(API, elements);
  const samples = Array.from({ length: INTERACTION_REFRESH_PROFILE.sampleCount }, (_, frame) =>
    Array.from({ length: RAW_SAMPLES_PER_FRAME }, (_, sample) => pointerAt(start, frame, sample)),
  );
  interaction.pointerDown({ ...start, pointerId: 1, pointerType: "mouse", pressure: 0 });
  let incorrectlyQueuedFrames = 0;
  let framesWithoutGeometryWrites = 0;
  fixture.renderer.resetInstrumentation();
  const pathBuilds = vi.spyOn(elementPath, "buildElementPathParts");
  const progressiveSteps = vi.spyOn(ProgressivePreviewPath.prototype, "step");
  runInteractionFrames((frame) => {
    const before = fixture.renderer.instrumentation().contentGeometryWrites;
    pathBuilds.mockClear();
    progressiveSteps.mockClear();
    for (const sample of samples[frame]!) interaction.pointerMove(sample);
    if (!(fixture.scheduler.pendingCount <= 2)) incorrectlyQueuedFrames += 1;
    fixture.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    fixture.scheduler.runFrame();
    // At most 64 immediate shapes plus four progressive completions per frame.
    expect(pathBuilds.mock.calls.length).toBeLessThanOrEqual(64 + 4);
    expect(progressiveSteps.mock.calls.length).toBeLessThanOrEqual(4);
    // The preview admits at most 256 paths: one canonical d write and up to
    // three transform writes (feedback, replacement reset, residual feedback).
    expect(fixture.renderer.instrumentation().contentGeometryWrites - before).toBeLessThanOrEqual(
      256 * 4,
    );
    if (!(fixture.renderer.instrumentation().contentGeometryWrites > before)) {
      framesWithoutGeometryWrites += 1;
    }
  });
  expect(incorrectlyQueuedFrames).toBe(0);
  expect(framesWithoutGeometryWrites).toBe(0);
  interaction.dispose();
  fixture.renderer.destroy();
  fixture.sceneStore.release();
  return {
    layoutUpdates,
    pageGrowths,
  };
}
