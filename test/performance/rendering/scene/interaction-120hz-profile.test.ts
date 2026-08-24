import { describe, expect, it } from "vitest";

import type { PageV1, StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/public";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import {
  FakeDocument,
  FakeNode,
  FakeScheduler,
  asElement,
} from "../../../unit/rendering/scene/fakes";
import { timingBudget } from "../../timing-budget";

const FRAME_DURATION_MS = 1_000 / 120;
const MAIN_THREAD_P99_MS = 6;
const LIVE_SAMPLE_COUNT = 3_600;
const INTERACTION_FRAME_COUNT = 600;
const ELEMENT_COUNT = 10_000;
const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
};
const PEN_STYLE: StrokeStyleV1 = {
  color: { type: "theme-text" },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
  width: 4,
};

describe("120 Hz interaction profile", () => {
  it("keeps live pressure-stroke updates within the main-thread p99 budget", async ({
    annotate,
  }) => {
    const { renderer, scheduler } = createRenderer(new ElementStore());
    scheduler.runAll();
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "pen", zoom: 1 },
      style: PEN_STYLE,
    });
    const durations: number[] = [];

    for (let sample = 0; sample < LIVE_SAMPLE_COUNT; sample += 1) {
      const startedAt = performance.now();
      const preview = builder.append(liveSample(sample));
      renderer.updateLiveStroke(preview, PEN_STYLE, "pen");
      durations.push(performance.now() - startedAt);
    }

    const p99 = percentile(durations, 0.99);
    expect(p99).toBeLessThanOrEqual(timingBudget(MAIN_THREAD_P99_MS));
    expect(renderer.instrumentation()).toMatchObject({
      liveMaximumTailNodes: 1,
      livePreviewUpdates: LIVE_SAMPLE_COUNT,
      liveTailNodesCreated: 1,
    });
    await annotate(profileAnnotation("live stroke", p99), "performance");
    renderer.destroy();
  });

  it("keeps 10,000-element camera and bounded selection frames within budget", async ({
    annotate,
  }) => {
    const fixture = createLargeStrokeFixture();
    const { renderer, scheduler } = createRenderer(new ElementStore(fixture.elements));
    scheduler.runAll();
    renderer.resetInstrumentation();

    const cameraDurations = measureCameraFrames(renderer, scheduler);
    const cameraStats = renderer.instrumentation();
    expect(cameraStats.spatialQueries).toBe(0);
    expect(cameraStats.visibilityHysteresisHits).toBe(INTERACTION_FRAME_COUNT);

    renderer.setPreviewTransform(fixture.ids, "translate(0 0)", 1);
    scheduler.runAll();
    renderer.resetInstrumentation();
    const selectionDurations = measureSelectionFrames(renderer, scheduler, fixture.ids);
    const cameraP99 = percentile(cameraDurations, 0.99);
    const selectionP99 = percentile(selectionDurations, 0.99);

    expect(cameraP99).toBeLessThanOrEqual(timingBudget(MAIN_THREAD_P99_MS));
    expect(selectionP99).toBeLessThanOrEqual(timingBudget(MAIN_THREAD_P99_MS));
    expect(renderer.mountedCount).toBeLessThan(ELEMENT_COUNT);
    await annotate(profileAnnotation("camera", cameraP99), "performance");
    await annotate(profileAnnotation("selection preview", selectionP99), "performance");
    renderer.destroy();
  });
});

function createRenderer(store: ElementStore) {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const container = asElement(new FakeNode(document, "div"));
  const layout = { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) };
  const sceneStore = new ElementSceneStore(store);
  const renderer = new SvgSceneRenderer({
    container,
    layout,
    page: PAGE,
    scheduler,
    store: sceneStore,
  });
  return { renderer, scheduler };
}

function createLargeStrokeFixture() {
  const elements = Array.from({ length: ELEMENT_COUNT }, (_, index) => indexedStroke(index));
  return { elements, ids: elements.map((element) => element.id) };
}

function liveSample(index: number) {
  return {
    pressure: 0.35 + (index % 11) * 0.05,
    time: index * FRAME_DURATION_MS,
    x: index * 0.75,
    y: 50 + Math.sin(index / 20) * 25,
  };
}

function measureCameraFrames(renderer: SvgSceneRenderer, scheduler: FakeScheduler): number[] {
  const durations: number[] = [];
  for (let frame = 0; frame < INTERACTION_FRAME_COUNT; frame += 1) {
    const startedAt = performance.now();
    renderer.setCamera({ x: -10 + Math.sin(frame / 30) * 10, zoom: 1 });
    scheduler.runAll();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

function measureSelectionFrames(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  ids: readonly string[],
): number[] {
  const durations: number[] = [];
  for (let frame = 0; frame < INTERACTION_FRAME_COUNT; frame += 1) {
    const startedAt = performance.now();
    renderer.setPreviewTransform(ids, `translate(${String(frame / 10)} 0)`, frame + 2);
    scheduler.runAll();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function profileAnnotation(label: string, p99: number): string {
  return `${label}: p99=${p99.toFixed(3)} ms, target=${MAIN_THREAD_P99_MS.toFixed(1)} ms, frame=${FRAME_DURATION_MS.toFixed(3)} ms`;
}
