import { describe, expect, it } from "vitest";

import { boundsIntersect } from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { moveSelection } from "../../../../src/editor/selection/transforms";
import { visibilityPageBounds } from "../../../../src/rendering/scene/scene-resource-policy";
import type { SceneCamera, SceneViewport } from "../../../../src/rendering/scene/types";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
} from "../../interaction-refresh-profile";
import { timingBudget } from "../../timing-budget";
import {
  INTERACTION_ELEMENT_COUNT,
  INTERACTION_PAGE,
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";
import { FakeScheduler } from "../../../unit/rendering/scene/fakes";

const FAKE_CLOCK_CHECKPOINTS_PER_FRAME = 4;
const DEFAULT_CAMERA: SceneCamera = { x: 0, zoom: 1 };
const DEFAULT_VIEWPORT: SceneViewport = { height: 100, left: 0, top: 0, width: 100 };

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz camera reconciliation profile`, () => {
  it("keeps coalesced pan, zoom, and viewport jumps within budget", async ({ annotate }) => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createProfileRenderer(fixture.store);
    renderer.setPage(INTERACTION_PAGE, 2_000);
    drainPendingFrames(scheduler);
    renderer.resetInstrumentation();

    const firstFrameDurations: number[] = [];
    const followUpDurations: number[] = [];
    let finalCamera: SceneCamera = DEFAULT_CAMERA;
    let finalViewport: SceneViewport = DEFAULT_VIEWPORT;
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      const phase = frame % 4;
      const viewport = {
        height: 100,
        left: 0,
        top: phase < 2 ? 0 : 800,
        width: 100,
      } satisfies SceneViewport;
      const camera = {
        x: phase % 2 === 0 ? 0 : -50,
        zoom: phase % 3 === 0 ? 1.05 : 1,
      } satisfies SceneCamera;
      const frameMetrics = runFirstFrameAndFollowUps(scheduler, () => {
        renderer.setViewport(viewport);
        renderer.setCamera(camera);
      });
      firstFrameDurations.push(frameMetrics.firstDurationMs);
      followUpDurations.push(...frameMetrics.followUpDurationsMs);
      finalCamera = camera;
      finalViewport = viewport;
      expect(scheduler.pendingCount).toBe(0);
    }

    const firstFrameP99 = interactionP99(firstFrameDurations);
    const followUpMetric = followUpStatistic(followUpDurations);
    const instrumentation = renderer.instrumentation();
    expect(firstFrameP99).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    if (followUpDurations.length > 0) {
      expect(followUpMetric).toBeLessThanOrEqual(
        timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
      );
    }
    expect(instrumentation.spatialQueries).toBeGreaterThan(0);
    expect(instrumentation.domEntrants).toBeGreaterThan(0);
    expect(instrumentation.domExits).toBeGreaterThan(0);
    expect(renderer.mountedCount).toBeLessThan(INTERACTION_ELEMENT_COUNT);
    expect(renderer.mountedIds("content")).toEqual(
      expectedVisibleIds(fixture.store, fixture.ids, finalViewport, finalCamera),
    );
    await annotate(
      interactionProfileAnnotation(
        "pan, zoom, and viewport reconciliation first frame",
        firstFrameP99,
      ),
      "performance",
    );
    await annotate(
      interactionProfileAnnotation(
        `pan, zoom, and viewport reconciliation follow-up frames (${String(followUpDurations.length)}, ${followUpMetricLabel(followUpDurations.length)})`,
        followUpMetric,
      ),
      "performance",
    );
    renderer.destroy();
  });
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz preview commit profile`, () => {
  it("keeps preview-to-single-element commit handoff within budget", async ({ annotate }) => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createProfileRenderer(fixture.store);
    drainPendingFrames(scheduler);
    const id = fixture.ids[0]!;
    let publishedDeltas = 0;
    const unsubscribe = fixture.store.subscribe((delta) => {
      publishedDeltas += 1;
      renderer.applyDelta({
        affected: delta.changes.map((change) => ({
          after: recordElement(change.after),
          before: recordElement(change.before),
          domains: change.domains,
          id: change.id,
        })),
      });
    });

    let failedHandoffs = 0;
    let failedReplacements = 0;
    const previewFirstFrameDurations: number[] = [];
    const commitFirstFrameDurations: number[] = [];
    const followUpDurations: number[] = [];
    const commitOperationDurations: number[] = [];
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      const distance = frame % 2 === 0 ? 0.01 : -0.01;
      const previewFrame = runFirstFrameAndFollowUps(scheduler, () => {
        renderer.setPreviewTransform([id], `translate(${String(distance)} 0)`, frame + 1);
      });
      previewFirstFrameDurations.push(previewFrame.firstDurationMs);
      followUpDurations.push(...previewFrame.followUpDurationsMs);
      const operationStartedAt = performance.now();
      const handoff = renderer.beginPreviewCommit();
      renderer.clearPreviewTransforms();
      if (!handoff.arm([id])) failedHandoffs += 1;
      const current = fixture.store.get(id)?.element as InkElementV1 | undefined;
      if (current === undefined) throw new Error("The commit fixture element is unavailable.");
      const replacement = moveSelection([current], { x: distance, y: 0 })[0]!;
      if (fixture.store.replace(id, replacement) === null) failedReplacements += 1;
      commitOperationDurations.push(performance.now() - operationStartedAt);
      const commitFrame = runPendingFrameAndFollowUps(scheduler);
      commitFirstFrameDurations.push(commitFrame.firstDurationMs);
      followUpDurations.push(...commitFrame.followUpDurationsMs);
      expect(scheduler.pendingCount).toBe(0);
    }

    const previewFirstFrameP99 = interactionP99(previewFirstFrameDurations);
    const commitFirstFrameP99 = interactionP99(commitFirstFrameDurations);
    const commitOperationP99 = interactionP99(commitOperationDurations);
    const followUpMetric = followUpStatistic(followUpDurations);
    expect(failedHandoffs).toBe(0);
    expect(failedReplacements).toBe(0);
    expect(publishedDeltas).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(previewFirstFrameP99).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(commitFirstFrameP99).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(commitOperationP99).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    if (followUpDurations.length > 0) {
      expect(followUpMetric).toBeLessThanOrEqual(
        timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
      );
    }
    expect(renderer.mountedIds("content")).toEqual(
      expectedVisibleIds(fixture.store, fixture.ids, DEFAULT_VIEWPORT, DEFAULT_CAMERA),
    );
    expect(renderer.hasPendingSceneCommit).toBe(false);
    await annotate(
      interactionProfileAnnotation("preview first frame", previewFirstFrameP99),
      "performance",
    );
    await annotate(
      interactionProfileAnnotation("commit first frame", commitFirstFrameP99),
      "performance",
    );
    await annotate(
      interactionProfileAnnotation("preview-to-commit operation", commitOperationP99),
      "performance",
    );
    await annotate(
      interactionProfileAnnotation(
        `preview-to-commit follow-up frames (${String(followUpDurations.length)}, ${followUpMetricLabel(followUpDurations.length)})`,
        followUpMetric,
      ),
      "performance",
    );
    unsubscribe();
    renderer.destroy();
  });
});

class ProfileScheduler extends FakeScheduler {
  public override now(): number {
    const current = this.time;
    this.time += INTERACTION_REFRESH_PROFILE.mainThreadP99Ms / FAKE_CLOCK_CHECKPOINTS_PER_FRAME;
    return current;
  }

  public override runNext(): void {
    this.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    super.runNext();
  }
}

function createProfileRenderer(store: ElementStore) {
  const scheduler = new ProfileScheduler();
  return createInteractionRenderer(store, {
    frameBudgetMs: () => INTERACTION_REFRESH_PROFILE.mainThreadP99Ms,
    scheduler,
  });
}

function runFirstFrameAndFollowUps(scheduler: ProfileScheduler, prepare: () => void): FrameMetrics {
  prepare();
  return runPendingFrameAndFollowUps(scheduler);
}

function runPendingFrameAndFollowUps(scheduler: ProfileScheduler): FrameMetrics {
  if (scheduler.pendingCount === 0) throw new Error("No frame is pending.");
  return runFrameAndFollowUps(scheduler);
}

function runFrameAndFollowUps(scheduler: ProfileScheduler): FrameMetrics {
  const firstFrameStartedAt = performance.now();
  scheduler.runNext();
  const firstDurationMs = performance.now() - firstFrameStartedAt;
  const followUpDurationsMs: number[] = [];
  let frameCount = 0;
  while (scheduler.pendingCount > 0) {
    if (frameCount >= 1_000) {
      throw new Error("Frame limit exceeded while draining follow-up frames.");
    }
    const followUpStartedAt = performance.now();
    scheduler.runNext();
    followUpDurationsMs.push(performance.now() - followUpStartedAt);
    frameCount += 1;
  }
  return { firstDurationMs, followUpDurationsMs };
}

function drainPendingFrames(scheduler: ProfileScheduler): void {
  while (scheduler.pendingCount > 0) runPendingFrameAndFollowUps(scheduler);
}

function expectedVisibleIds(
  store: ElementStore,
  ids: readonly string[],
  viewport: SceneViewport,
  camera: SceneCamera,
): readonly string[] {
  const { envelope } = visibilityPageBounds(viewport, camera);
  return ids.filter((id) => {
    const record = store.get(id);
    return record !== undefined && boundsIntersect(record.bounds, envelope);
  });
}

function followUpStatistic(values: readonly number[]): number {
  if (values.length === 0) return 0;
  if (values.length < 100) return Math.max(...values);
  return interactionP99(values);
}

function followUpMetricLabel(sampleCount: number): string {
  return sampleCount < 100 ? "max" : "p99";
}

interface FrameMetrics {
  readonly firstDurationMs: number;
  readonly followUpDurationsMs: readonly number[];
}

function recordElement(record: { readonly element: unknown } | null): InkElementV1 | null {
  return record === null ? null : (record.element as InkElementV1);
}
