import { afterEach, describe, expect, it, vi } from "vitest";
import * as motionVisual from "../../../../../src/rendering/scene/presentation/motion-visual";

import { boundsIntersect } from "../../../../../src/domain/geometry/public";
import { CanonicalElementPathPreparation } from "../../../../../src/domain/geometry/canonical-element-path-preparation";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { SpatialQueryCursor } from "../../../../../src/domain/spatial/query-cursor";
import { ElementStore, type StoreDelta } from "../../../../../src/domain/store/public";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { visibilityPageBounds } from "../../../../../src/rendering/scene/scene-resource-policy";
import {
  DETACHED_ELEMENT_CACHE_MAX_BYTES,
  PATH_CACHE_MAX_BYTES,
  SCENE_PUBLICATION_ROOTS_PER_FRAME,
} from "../../../../../src/rendering/scene/constants";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene";
import type { SceneCamera, SceneViewport } from "../../../../../src/rendering/scene/types";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";
import {
  INTERACTION_ELEMENT_COUNT,
  INTERACTION_PAGE,
  createInteractionFixture,
  createInteractionRenderer,
} from "../interaction-refresh-profile-fixture";
import { FakeNode, FakeScheduler } from "../../../../unit/rendering/scene/fakes";

// Scheduling time advances at observed work boundaries, never at clock reads.
// This controlled work cost exercises deadlines without claiming execution speed.
const SIMULATED_WORK_COST_MS = 0.5;
const TRANSITIONS = 12;
const DEFAULT_CAMERA: SceneCamera = { x: 0, zoom: 1 };
const DEFAULT_VIEWPORT: SceneViewport = { height: 100, left: 0, top: 0, width: 100 };

afterEach(() => vi.restoreAllMocks());

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz camera reconciliation profile`, () => {
  it("keeps coalesced pan, zoom, and viewport jumps with bounded work", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createProfileRenderer(fixture.store);
    renderer.setPage(INTERACTION_PAGE, 2_000);
    drainPendingFrames(scheduler);
    renderer.resetInstrumentation();

    let finalCamera: SceneCamera = DEFAULT_CAMERA;
    let finalViewport: SceneViewport = DEFAULT_VIEWPORT;
    let entrants = 0;
    let exits = 0;
    const content = (renderer.svg as unknown as FakeNode).nodes[1]!.nodes[4]!;
    const initialRemovals = scheduler.totalRemovedRoots;
    for (let frame = 0; frame < TRANSITIONS; frame += 1) {
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
      const previous = new Set(renderer.mountedIds("content"));
      const envelopeIds = expectedVisibleIds(fixture.store, fixture.ids, viewport, camera);
      const hysteresis = renderer.instrumentation().visibilityHysteresisHits;
      const removals = scheduler.totalRemovedRoots;
      runFirstFrameAndFollowUps(scheduler, () => {
        renderer.setViewport(viewport);
        renderer.setCamera(camera);
      });
      // Hysteresis reuses the last admitted envelope's complete membership.
      const reused = renderer.instrumentation().visibilityHysteresisHits > hysteresis;
      const expected = new Set(reused ? previous : envelopeIds);
      const leaving = [...previous].filter((id) => !expected.has(id)).length;
      entrants += [...expected].filter((id) => !previous.has(id)).length;
      exits += leaving;
      expect(renderer.mountedIds("content")).toEqual([...expected]);
      expect(content.nodes).toHaveLength(expected.size);
      expect(scheduler.totalRemovedRoots - removals).toBe(leaving);
      finalCamera = camera;
      finalViewport = viewport;
      expect(scheduler.pendingCount).toBe(0);
    }

    const instrumentation = renderer.instrumentation();
    expect(instrumentation.spatialQueries).toBeGreaterThan(0);
    expect(instrumentation.domEntrants).toBe(entrants);
    expect(instrumentation.domExits).toBe(exits);
    expect(scheduler.totalRemovedRoots - initialRemovals).toBe(exits);
    expect(exits).toBeGreaterThan(0);
    expect(instrumentation.detachedCacheEntries).toBeGreaterThan(0);
    expect(instrumentation.detachedCacheBytes).toBeLessThanOrEqual(
      DETACHED_ELEMENT_CACHE_MAX_BYTES,
    );
    expect(instrumentation.pathCacheBytes).toBeLessThanOrEqual(PATH_CACHE_MAX_BYTES);
    expect(renderer.mountedCount).toBeLessThan(INTERACTION_ELEMENT_COUNT);
    expect(renderer.mountedIds("content")).toEqual(
      expectedVisibleIds(fixture.store, fixture.ids, finalViewport, finalCamera),
    );
    renderer.destroy();
  });
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz preview commit profile`, () => {
  it("keeps preview-to-single-element commit handoff with bounded work", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createProfileRenderer(fixture.store);
    drainPendingFrames(scheduler);
    const id = fixture.ids[0]!;
    let publishedDeltas = 0;
    const unsubscribe = fixture.store.subscribe((delta) => {
      publishedDeltas += 1;
      applyStoreDelta(renderer, delta);
    });

    let failedHandoffs = 0;
    let failedReplacements = 0;
    for (let frame = 0; frame < TRANSITIONS; frame += 1) {
      const distance = frame % 2 === 0 ? 0.01 : -0.01;
      fixture.store.resetInstrumentation();
      renderer.resetInstrumentation();
      runFirstFrameAndFollowUps(scheduler, () => {
        renderer.setPreviewTransform([id], `translate(${String(distance)} 0)`, frame + 1);
      });
      const handoff = renderer.beginPreviewCommit();
      renderer.clearPreviewTransforms();
      if (!handoff.arm([id])) failedHandoffs += 1;
      const current = fixture.store.get(id)?.element as InkElementV1 | undefined;
      if (current === undefined) throw new Error("The commit fixture element is unavailable.");
      const replacement = moveSelection([current], { x: distance, y: 0 })[0]!;
      if (fixture.store.replace(id, replacement) === null) failedReplacements += 1;
      runPendingFrameAndFollowUps(scheduler);
      expect(scheduler.pendingCount).toBe(0);
      expect(fixture.store.instrumentation.fullStoreScans).toBe(0);
      expect(fixture.store.instrumentation.bandScans).toBe(0);
      expect(renderer.instrumentation().geometryBuilds).toBeLessThanOrEqual(1);
    }

    expect(failedHandoffs).toBe(0);
    expect(failedReplacements).toBe(0);
    expect(publishedDeltas).toBe(TRANSITIONS);
    expect(renderer.mountedIds("content")).toEqual(
      expectedVisibleIds(fixture.store, fixture.ids, DEFAULT_VIEWPORT, DEFAULT_CAMERA),
    );
    expect(renderer.hasPendingSceneCommit).toBe(false);
    unsubscribe();
    renderer.destroy();
  });
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz reconciliation work bounds`, () => {
  it("bounds frame work and makes progress through repeated disjoint viewport jumps", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createProfileRenderer(fixture.store);
    try {
      drainPendingFrames(scheduler);
      const content = (renderer.svg as unknown as FakeNode).nodes[1]!.nodes[4]!;
      for (let transition = 0; transition < 16; transition += 1) {
        const viewport = { ...DEFAULT_VIEWPORT, top: transition % 2 === 0 ? 800 : 0 };
        const camera = { x: transition % 3 === 0 ? -50 : 0, zoom: transition % 4 ? 1 : 1.05 };
        const previous = new Set(renderer.mountedIds("content"));
        const expected = expectedVisibleIds(fixture.store, fixture.ids, viewport, camera);
        const entrants = expected.filter((id) => !previous.has(id)).length;
        const expectedSet = new Set(expected);
        const exits = [...previous].filter((id) => !expectedSet.has(id)).length;
        // Order proof and priority classification precede the existing mount/exit phases.
        const maximumFrames = previous.size + expected.length * 3 + exits + 2;
        renderer.resetInstrumentation();
        fixture.store.resetInstrumentation();
        renderer.setViewport(viewport);
        renderer.setCamera(camera);
        drainBoundedReconciliation(renderer, scheduler, maximumFrames);
        expect(renderer.mountedIds("content")).toEqual(expected);
        const stats = renderer.instrumentation();
        expect(stats.spatialQueries).toBe(1);
        expect(stats.domEntrants).toBe(entrants);
        expect(stats.domRootsPublished).toBe(entrants);
        expect(stats.domExits).toBe(exits);
        expect(content.nodes).toHaveLength(expected.length);
        expect(new Set(content.nodes).size).toBe(expected.length);
        expect(stats.detachedCacheBytes).toBeLessThanOrEqual(DETACHED_ELEMENT_CACHE_MAX_BYTES);
        expect(stats.pathCacheBytes).toBeLessThanOrEqual(PATH_CACHE_MAX_BYTES);
        expect(stats.geometryBuilds).toBeLessThanOrEqual(entrants);
        // Order, priority, warm checks, stage/retry, and newly mounted exit-iterator visits.
        expect(stats.visibilityReconcileVisits).toBeLessThanOrEqual(
          previous.size + expected.length * 6 + 16,
        );
        expect(fixture.store.instrumentation.fullStoreScans).toBe(0);
        expect(fixture.store.instrumentation.bandScans).toBe(0);
      }
    } finally {
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz erased SVG cleanup`, () => {
  it("budgets initial fade writes against the live refresh profile across repeated calls", () => {
    const fixture = createInteractionFixture();
    let budget = INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs;
    const { renderer, scheduler } = createFullyVisibleRenderer(fixture.store, () => budget);
    let starts = 0;
    const content = (renderer.svg as unknown as FakeNode).nodes[1]!.nodes[4]!;
    const observedNodes = content.nodes.flatMap((root) => [root, ...root.nodes]);
    for (const node of observedNodes) {
      const animate = node.animate.bind(node);
      node.animate = (...args) => {
        starts += 1;
        scheduler.time += 1;
        return animate(...args);
      };
    }
    const ids = fixture.ids.slice(0, 256);
    for (const nextBudget of [budget, budget / 2]) {
      budget = nextBudget;
      starts = 0;
      renderer.setElementFade(ids.slice(0, 128), 300);
      expect(starts).toBe(Math.ceil(budget));
      renderer.setElementFade(ids.slice(128), 300);
      expect(starts).toBe(Math.ceil(budget));
      expect(scheduler.pendingCount).toBe(1);
      renderer.clearElementFade(ids);
      scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      scheduler.runAll();
    }
    for (const node of observedNodes) Reflect.deleteProperty(node, "animate");
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  });

  it("bounds physical removals while continuing pointer feedback in a 10,000-stroke scene", () => {
    const fixture = createInteractionFixture();
    const { renderer, scheduler } = createFullyVisibleRenderer(fixture.store);
    const ids = fixture.ids.slice(0, 2_000);
    renderer.setElementFade(ids, 0);
    const delta = fixture.store.remove(ids)!;
    applyStoreDelta(renderer, delta);
    const append = vi.spyOn(FakeNode.prototype, "append");
    const remove = vi.spyOn(FakeNode.prototype, "remove");
    const write = vi.spyOn(FakeNode.prototype, "setAttribute");
    let frames = 0;
    let removed = 0;
    try {
      while (scheduler.pendingCount > 0) {
        expect(scheduler.pendingCount).toBe(1);
        // Bounded fade starts, exit batches, and preparation/completion handoffs.
        expect(frames).toBeLessThan(Math.ceil(ids.length / 128) + Math.ceil(ids.length / 64) + 2);
        const path = `M ${String(frames)} 0 L 10 10`;
        renderer.setOverlayPath(path);
        remove.mockClear();
        write.mockClear();
        scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
        scheduler.runNext();
        expect(remove.mock.calls.length).toBeLessThanOrEqual(64);
        expect(write).toHaveBeenCalledWith("d", path);
        removed += remove.mock.calls.length;
        frames += 1;
      }
      expect(append).not.toHaveBeenCalled();
      expect(removed).toBe(ids.length);
      expect(renderer.mountedIds("content")).toEqual(fixture.ids.slice(ids.length));
      expect(renderer.hasPendingSceneCommit).toBe(false);
    } finally {
      append.mockRestore();
      remove.mockRestore();
      write.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe("restored stroke motion work", () => {
  it("does not build survivor crossfade paths when restoring 2,000 of 10,000 strokes", async () => {
    const fixture = createInteractionFixture();
    const restored = fixture.elements.slice(0, 2_000);
    fixture.store.remove(restored.map(({ id }) => id));
    const { renderer, scheduler } = createInteractionRenderer(fixture.store);
    renderer.setViewport({ height: 100, left: 0, top: 200, width: 100 });
    scheduler.runAll();
    expect(renderer.mountedCount).toBeGreaterThan(256);
    expect(renderer.mountedCount).toBeLessThan(900);
    const createVisual = vi.spyOn(motionVisual, "createMotionVisual");
    const unsubscribe = fixture.store.subscribe((delta) => applyStoreDelta(renderer, delta));
    try {
      const prepared = await fixture.store.prepareElementMutation(
        { bands: { content: fixture.ids, highlight: [] }, elements: restored },
        { shouldYield: () => false, yieldControl: async () => undefined },
      );
      if (prepared.token === null) throw new Error("Expected a prepared restoration.");
      expect(fixture.store.commitPreparedElementMutation(prepared.token).status).toBe("committed");
      expect(createVisual.mock.calls.length).toBe(0);
      scheduler.runAll();
      expect(createVisual.mock.calls.length).toBe(0);
      expect(renderer.instrumentation().motionCacheEntries).toBe(0);
      expect(fixture.store.size).toBe(INTERACTION_ELEMENT_COUNT);
    } finally {
      unsubscribe();
      createVisual.mockRestore();
      renderer.destroy();
    }
    expect(scheduler.pendingCount).toBe(0);
  });
});

class ProfileScheduler extends FakeScheduler {
  public publishedRoots = 0;
  public removedRoots = 0;
  public totalRemovedRoots = 0;

  public override runNext(): void {
    this.publishedRoots = 0;
    this.removedRoots = 0;
    this.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    super.runNext();
    expect(this.publishedRoots).toBeLessThanOrEqual(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(this.removedRoots).toBeLessThanOrEqual(64);
  }
}

function createProfileRenderer(store: ElementStore) {
  const scheduler = new ProfileScheduler();
  observePreparationWork(scheduler);
  const fixture = createInteractionRenderer(store, {
    frameBudgetMs: () => INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
    scheduler,
  });
  const content = (fixture.renderer.svg as unknown as FakeNode).nodes[1]!.nodes[4]!;
  const originalInsert = content.insertBefore.bind(content);
  vi.spyOn(content, "insertBefore").mockImplementation((node, successor) => {
    const roots = node.fragment ? node.nodes.length : 1;
    const result = originalInsert(node, successor);
    scheduler.publishedRoots += roots;
    scheduler.time += roots * SIMULATED_WORK_COST_MS;
    return result;
  });
  const originalRemove = Object.getOwnPropertyDescriptor(FakeNode.prototype, "remove")!
    .value as FakeNode["remove"];
  vi.spyOn(FakeNode.prototype, "remove").mockImplementation(function (this: FakeNode) {
    scheduler.removedRoots += 1;
    scheduler.totalRemovedRoots += 1;
    originalRemove.call(this);
  });
  return { ...fixture, scheduler };
}

function observePreparationWork(scheduler: FakeScheduler): void {
  const originalGet = Object.getOwnPropertyDescriptor(ElementSceneStore.prototype, "get")!
    .value as ElementSceneStore["get"];
  vi.spyOn(ElementSceneStore.prototype, "get").mockImplementation(function (
    this: ElementSceneStore,
    id,
  ) {
    const record = originalGet.call(this, id);
    scheduler.time += SIMULATED_WORK_COST_MS;
    return record;
  });
  const originalAdvance = Object.getOwnPropertyDescriptor(SpatialQueryCursor.prototype, "advance")!
    .value as SpatialQueryCursor<unknown>["advance"];
  vi.spyOn(SpatialQueryCursor.prototype, "advance").mockImplementation(function (
    this: SpatialQueryCursor<unknown>,
    maximum,
  ) {
    const result = originalAdvance.call(this, maximum);
    scheduler.time += result.workUnits * SIMULATED_WORK_COST_MS;
    return result;
  });
  const originalStep = Object.getOwnPropertyDescriptor(
    CanonicalElementPathPreparation.prototype,
    "step",
  )!.value as CanonicalElementPathPreparation["step"];
  vi.spyOn(CanonicalElementPathPreparation.prototype, "step").mockImplementation(function (
    this: CanonicalElementPathPreparation,
    deadline,
    now,
  ) {
    const complete = originalStep.call(this, deadline, now);
    scheduler.time += SIMULATED_WORK_COST_MS;
    return complete;
  });
}

function runFirstFrameAndFollowUps(scheduler: FakeScheduler, prepare: () => void): void {
  prepare();
  runPendingFrameAndFollowUps(scheduler);
}

function runPendingFrameAndFollowUps(scheduler: FakeScheduler): void {
  expect(scheduler.pendingCount).toBe(1);
  runFrameAndFollowUps(scheduler);
}

function runFrameAndFollowUps(scheduler: FakeScheduler): void {
  let frameCount = 0;
  while (scheduler.pendingCount > 0) {
    expect(scheduler.pendingCount).toBe(1);
    expect(frameCount).toBeLessThan(INTERACTION_ELEMENT_COUNT + 2);
    scheduler.runNext();
    frameCount += 1;
  }
}

function drainPendingFrames(scheduler: FakeScheduler): void {
  while (scheduler.pendingCount > 0) runPendingFrameAndFollowUps(scheduler);
}

function drainBoundedReconciliation(
  renderer: SvgSceneRenderer,
  scheduler: ProfileScheduler,
  maximumFrames: number,
): void {
  let frames = 0;
  while (scheduler.pendingCount > 0) {
    expect(scheduler.pendingCount).toBe(1);
    expect(frames, JSON.stringify(renderer.instrumentation())).toBeLessThan(maximumFrames);
    scheduler.publishedRoots = 0;
    scheduler.runNext();
    frames += 1;
    expect(scheduler.publishedRoots).toBeLessThanOrEqual(SCENE_PUBLICATION_ROOTS_PER_FRAME);
  }
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

function recordElement(record: { readonly element: unknown } | null): InkElementV1 | null {
  return record === null ? null : (record.element as InkElementV1);
}

function applyStoreDelta(renderer: SvgSceneRenderer, delta: StoreDelta): void {
  renderer.applyDelta({
    affected: delta.changes.map((change) => ({
      after: recordElement(change.after),
      before: recordElement(change.before),
      domains: change.domains,
      id: change.id,
    })),
  });
}

function createFullyVisibleRenderer(
  store: ElementStore,
  frameBudgetMs = () => INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
) {
  const fixture = createInteractionRenderer(store, { frameBudgetMs });
  fixture.scheduler.runAll(1_000);
  fixture.renderer.setPage(INTERACTION_PAGE, 2_000);
  fixture.renderer.setViewport({ height: 2_000, left: 0, top: 0, width: 2_000 });
  fixture.scheduler.runAll(1_000);
  expect(fixture.renderer.mountedCount).toBe(INTERACTION_ELEMENT_COUNT);
  return fixture;
}
