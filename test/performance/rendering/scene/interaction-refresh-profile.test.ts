import { describe, expect, it } from "vitest";

import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { FakeScheduler } from "../../../unit/rendering/scene/fakes";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../../interaction-refresh-profile";
import { expectTiming } from "../../timing-assertions";
import {
  INTERACTION_ELEMENT_COUNT,
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz interaction profile`, () => {
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

    expectTiming(cameraP99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(selectionP99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expect(renderer.mountedCount).toBeLessThan(INTERACTION_ELEMENT_COUNT);
    await annotate(interactionProfileAnnotation("camera", cameraP99), "performance");
    await annotate(interactionProfileAnnotation("selection preview", selectionP99), "performance");
    renderer.destroy();
  });
});

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
