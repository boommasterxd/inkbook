import { describe, expect, it, vi } from "vitest";

import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { ScenePathCache } from "../../../../src/rendering/scene/content/path-cache";
import { type FakeScheduler, fakeNode } from "../../../unit/rendering/scene/fakes";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import {
  INTERACTION_ELEMENT_COUNT,
  INTERACTION_PAGE,
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

const PREVIEW_FRAMES = 12;

describe("scene interaction work", () => {
  it("extends and restores background coverage without touching 10,000 retained strokes", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    renderer.setPage({ ...INTERACTION_PAGE, background: { type: "squares", spacing: 50 } }, 200);
    scheduler.runAll();
    renderer.resetInstrumentation();
    const reads = vi.spyOn(ElementSceneStore.prototype, "get");
    const preparations = vi.spyOn(ScenePathCache.prototype, "startPreparation");
    const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    try {
      renderer.setMinimumBackgroundBlockSize(360);
      scheduler.runAll();
      expect(renderer.instrumentation().backgroundBuilds).toBe(1);
      expect(renderer.instrumentation()).toMatchObject({
        contentAttributeWrites: 0,
        geometryBuilds: 0,
        visibilityCandidateVisits: 0,
      });
      expect(reads).not.toHaveBeenCalled();
      expect(preparations).not.toHaveBeenCalled();
      for (const height of [220, 280, 360, 300, 240, 100]) {
        renderer.setMinimumBackgroundBlockSize(360);
        renderer.setViewport({ height, left: 0, top: 0, width: 100 });
        scheduler.runAll();
      }
      expect(renderer.instrumentation().backgroundBuilds).toBe(1);
      renderer.resetInstrumentation();
      reads.mockClear();
      preparations.mockClear();
      const retained = [...content.nodes];
      renderer.setMinimumBackgroundBlockSize(0);
      scheduler.runAll();
      expect(renderer.instrumentation()).toMatchObject({
        backgroundBuilds: 1,
        contentAttributeWrites: 0,
        contentGeometryWrites: 0,
        domEntrants: 0,
        domExits: 0,
        geometryBuilds: 0,
        visibilityCandidateVisits: 0,
      });
      expect(reads).not.toHaveBeenCalled();
      expect(preparations).not.toHaveBeenCalled();
      expect(content.nodes).toEqual(retained);
    } finally {
      reads.mockRestore();
      preparations.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  });

  it("retains geometry through camera and selection preview updates", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    scheduler.runAll();
    renderer.resetInstrumentation();
    const mounted = new Set(renderer.mountedIds("content"));
    const preparations = vi.spyOn(ScenePathCache.prototype, "startPreparation");

    runCameraFrames(renderer, scheduler);
    const cameraStats = renderer.instrumentation();
    expect(cameraStats.spatialQueries).toBe(0);
    expect(cameraStats.visibilityHysteresisHits).toBe(PREVIEW_FRAMES);
    expect(cameraStats).toMatchObject({ domEntrants: 0, domExits: 0 });
    // The rightward strip covers at most 14 ten-unit columns and 39 nonnegative rows.
    // Local preparation may finish this indexed region without a transport-ID CPU quota.
    expect(cameraStats.geometryBuilds).toBeLessThanOrEqual(14 * 39);
    expect(preparations.mock.calls.length).toBe(cameraStats.geometryBuilds);
    expect(new Set(preparations.mock.calls.map(([element]) => element.id)).size).toBe(
      preparations.mock.calls.length,
    );
    expect(preparations.mock.calls.every(([element]) => !mounted.has(element.id))).toBe(true);
    preparations.mockRestore();

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
