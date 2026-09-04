import { describe, expect, it } from "vitest";

import { calculateElementBounds, derivePageExtent } from "../../../src/domain/geometry/public";
import type {
  InkElementV1,
  PageV1,
  PointV1,
  StrokeElementV1,
} from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import {
  layoutSelectionHandles,
  type SelectedElementGeometry,
} from "../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/handle-interaction";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import { SvgSceneRenderer } from "../../../src/rendering/scene";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { FakeDocument, FakeNode, FakeScheduler, asElement } from "../../unit/rendering/scene/fakes";
import { coordinateSystem, table } from "../../unit/domain/geometry/fixtures";
import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";
import { maximumStroke } from "../editor/maximum-stroke-fixture";

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};
const RAW_SAMPLES_PER_FRAME = 4;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz selection resize frame pipeline`, () => {
  it("keeps pointer-to-scene resize frames within budget", async ({ annotate }) => {
    const profiles = [
      ["mixed exact resize", mixedExactElements()],
      ["long pressure fallback resize", longPressureElements()],
      ["10,000-element fallback resize", fallbackElements()],
    ] as const;
    for (const [name, elements] of profiles) {
      const result = measurePipeline(elements);
      expect(result.layoutUpdates).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
      expect(result.pageGrowths).toBeGreaterThan(0);
      expect(result.p99).toBeLessThanOrEqual(
        timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
      );
      await annotate(interactionProfileAnnotation(name, result.p99), "performance");
    }
  });
});

function measurePipeline(elements: readonly InkElementV1[]) {
  let pageHeight = derivePageExtent(PAGE, maximumBottom(elements)).activeHeight;
  const fixture = createPipeline(elements, pageHeight);
  let layoutUpdates = 0;
  let pageGrowths = 0;
  const interaction = createInteraction(fixture, elements, (maximumBottom) => {
    layoutUpdates += 1;
    const nextHeight = derivePageExtent(PAGE, maximumBottom).activeHeight;
    if (nextHeight <= pageHeight) return;
    pageHeight = nextHeight;
    pageGrowths += 1;
    fixture.renderer.setPage(PAGE, pageHeight);
  });
  const start = resizeHandle(elements);
  interaction.pointerDown({ ...start, pointerId: 1, pointerType: "mouse", pressure: 0 });
  fixture.renderer.resetInstrumentation();
  const durations = measureInteractionFrames((frame) => {
    for (let sample = 0; sample < RAW_SAMPLES_PER_FRAME; sample += 1) {
      interaction.pointerMove(pointerAt(start, frame, sample));
    }
    if (fixture.scheduler.pendingCount !== 1) throw new Error("Expected one handle frame.");
    fixture.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    fixture.scheduler.runAll();
  });
  interaction.dispose();
  fixture.renderer.destroy();
  fixture.sceneStore.release();
  return { layoutUpdates, p99: interactionP99(durations), pageGrowths };
}

function createPipeline(elements: readonly InkElementV1[], pageHeight: number) {
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const scheduler = new FakeScheduler();
  const document = new FakeDocument();
  const renderer = new SvgSceneRenderer({
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
  fixture: ReturnType<typeof createPipeline>,
  elements: readonly InkElementV1[],
  updateBottom: (maximumBottom: number) => void,
): ActiveEditorHandleInteraction {
  const model = {
    setGestureActive: () => undefined,
    store: fixture.store,
  } as unknown as EditableDocumentModel;
  return new ActiveEditorHandleInteraction({
    frameScheduler: fixture.scheduler,
    history: new ActiveEditorHistory(model),
    layout: { begin: () => undefined, finish: () => undefined, updateBottom },
    model,
    pageToScreen: (point) => point,
    preparedHistory: {} as never,
    renderer: fixture.renderer,
    sceneStore: fixture.sceneStore,
    selection: () => new Set(elements.map(({ id }) => id)),
    zoom: () => 1,
  });
}

function resizeHandle(elements: readonly InkElementV1[]): PointV1 {
  const selected: SelectedElementGeometry[] = elements.map((element) => ({
    bounds: calculateElementBounds(element),
    element,
  }));
  const handle = layoutSelectionHandles(selected, { zoom: 1 }).find(
    (candidate) => candidate.kind === "scale" && candidate.position === "bottom-right",
  );
  if (handle?.kind !== "scale") throw new TypeError("Expected a scale handle.");
  return handle.point;
}

function pointerAt(start: PointV1, frame: number, sample: number) {
  const progress = frame * RAW_SAMPLES_PER_FRAME + sample + 1;
  return {
    pointerId: 1,
    pointerType: "mouse" as const,
    pressure: 0,
    x: start.x + 30 + progress * 0.02,
    y: start.y + 80 + progress * 0.25,
  };
}

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

function maximumBottom(elements: readonly InkElementV1[]): number | null {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    maximum = Math.max(maximum, calculateElementBounds(element).maxY);
  }
  return Number.isFinite(maximum) ? maximum : null;
}
