import { describe, expect, it } from "vitest";

import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { FakeScheduler } from "../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import {
  INTERACTION_ELEMENT_COUNT,
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

const PREVIEW_FRAMES = 12;

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz interaction profile`, () => {
  it("retains geometry through camera and selection preview updates", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    scheduler.runAll();
    renderer.resetInstrumentation();

    runCameraFrames(renderer, scheduler);
    const cameraStats = renderer.instrumentation();
    expect(cameraStats.spatialQueries).toBe(0);
    expect(cameraStats.visibilityHysteresisHits).toBe(PREVIEW_FRAMES);
    expect(cameraStats).toMatchObject({ domEntrants: 0, domExits: 0, geometryBuilds: 0 });

    renderer.setPreviewTransform(fixture.ids, "translate(0 0)", 1);
    scheduler.runAll();
    renderer.resetInstrumentation();
    runSelectionFrames(renderer, scheduler, fixture.ids);
    expect(renderer.instrumentation()).toMatchObject({
      domEntrants: 0,
      domExits: 0,
      geometryBuilds: 0,
    });
    expect(renderer.mountedCount).toBeLessThan(INTERACTION_ELEMENT_COUNT);
    renderer.destroy();
  });
});

function runCameraFrames(renderer: SvgSceneRenderer, scheduler: FakeScheduler): void {
  for (let frame = 0; frame < PREVIEW_FRAMES; frame += 1) {
    renderer.setCamera({ x: -10 + Math.sin(frame / 30) * 10, zoom: 1 });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
  }
}

function runSelectionFrames(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  ids: readonly string[],
): void {
  for (let frame = 0; frame < PREVIEW_FRAMES; frame += 1) {
    renderer.setPreviewTransform(ids, `translate(${String(frame / 10)} 0)`, frame + 2);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
  }
}
