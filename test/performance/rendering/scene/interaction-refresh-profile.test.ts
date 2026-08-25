import { describe, expect, it } from "vitest";

import type { StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/public";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { FakeScheduler } from "../../../unit/rendering/scene/fakes";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../../interaction-refresh-profile";
import { timingBudget } from "../../timing-budget";
import {
  INTERACTION_ELEMENT_COUNT,
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

const LIVE_SAMPLE_COUNT = 3_600;
const PEN_STYLE: StrokeStyleV1 = {
  color: { type: "theme-text" },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
  width: 4,
};

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz interaction profile`, () => {
  it("keeps live pressure-stroke updates within the main-thread p99 budget", async ({
    annotate,
  }) => {
    const { renderer, scheduler } = createInteractionRenderer(new ElementStore());
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

    const p99 = interactionP99(durations);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    expect(renderer.instrumentation()).toMatchObject({
      liveMaximumTailNodes: 1,
      livePreviewUpdates: LIVE_SAMPLE_COUNT,
      liveTailNodesCreated: 1,
    });
    await annotate(interactionProfileAnnotation("live stroke", p99), "performance");
    renderer.destroy();
  });

  it("keeps 10,000-element camera and bounded selection frames within budget", async ({
    annotate,
  }) => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    scheduler.runAll();
    renderer.resetInstrumentation();

    const cameraDurations = measureCameraFrames(renderer, scheduler);
    const cameraStats = renderer.instrumentation();
    expect(cameraStats.spatialQueries).toBe(0);
    expect(cameraStats.visibilityHysteresisHits).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);

    renderer.setPreviewTransform(fixture.ids, "translate(0 0)", 1);
    scheduler.runAll();
    renderer.resetInstrumentation();
    const selectionDurations = measureSelectionFrames(renderer, scheduler, fixture.ids);
    const cameraP99 = interactionP99(cameraDurations);
    const selectionP99 = interactionP99(selectionDurations);

    expect(cameraP99).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(selectionP99).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(renderer.mountedCount).toBeLessThan(INTERACTION_ELEMENT_COUNT);
    await annotate(interactionProfileAnnotation("camera", cameraP99), "performance");
    await annotate(interactionProfileAnnotation("selection preview", selectionP99), "performance");
    renderer.destroy();
  });
});

function liveSample(index: number) {
  return {
    pressure: 0.35 + (index % 11) * 0.05,
    time: index * INTERACTION_REFRESH_PROFILE.frameDurationMs,
    x: index * 0.75,
    y: 50 + Math.sin(index / 20) * 25,
  };
}

function measureCameraFrames(renderer: SvgSceneRenderer, scheduler: FakeScheduler): number[] {
  return measureInteractionFrames((frame) => {
    renderer.setCamera({ x: -10 + Math.sin(frame / 30) * 10, zoom: 1 });
    scheduler.runAll();
  });
}

function measureSelectionFrames(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  ids: readonly string[],
): number[] {
  return measureInteractionFrames((frame) => {
    renderer.setPreviewTransform(ids, `translate(${String(frame / 10)} 0)`, frame + 2);
    scheduler.runAll();
  });
}
