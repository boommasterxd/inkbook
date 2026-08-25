import { describe, expect, it } from "vitest";

import type {
  BoxShapeElementV1,
  InkElementV1,
  LineElementV1,
  StrokeElementV1,
} from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import type { TimeSlicedSelectionCommitPreparation } from "../../../src/editor/selection/handle-session";
import { SelectionHandleSession } from "../../../src/editor/selection/public";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";

import { MeasuredSliceScheduler, percentile } from "../domain/domain-scenarios";
import { connectedLine } from "../../unit/domain/store/fixtures";
import { maximumStroke } from "./maximum-stroke-fixture";
import { createPassThroughMoveSession } from "./selection-session-fixture";
import { INTERACTION_REFRESH_PROFILE, interactionP99 } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

describe("selection hot paths", () => {
  it("routes 488 maximum strokes through the indexed hit path and bounded commit slices", async () => {
    const strokes = Array.from({ length: 488 }, (_, index) => maximumViewportStroke(index));
    const session = movedSession(strokes);

    const decisionDurations = measureCommitDecisions(session);
    const hitDurations = measureIndexedMisses(strokes);
    const { maximumSlice, prepared, sliceDurations } = await prepareInMeasuredSlices(session);

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected an exact time-sliced commit.");
    const first = prepared.replacements[0];
    const last = prepared.replacements[prepared.replacements.length - 1];
    if (first?.kind !== "stroke" || last?.kind !== "stroke") {
      throw new Error("Expected maximum-stroke replacements.");
    }
    expect(first.points.slice(0, 3)).toEqual(new Float64Array([4, 103, 0.5]));
    expect(last.points.slice(-3)).toEqual(new Float64Array([11, 103.487, 0.5]));
    expect(interactionP99(decisionDurations)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(interactionP99(hitDurations)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(percentile(sliceDurations, 0.95)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(maximumSlice).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs),
    );
  });

  it("bounds preparation for a near-maximum 19,929-endpoint selection fan-out", async () => {
    const { elements, targetIds } = maximumEndpointFixture();
    const store = new ElementStore(elements);
    await warmEndpointPreparation(store, targetIds);
    store.resetInstrumentation();
    const session = endpointSession(store, targetIds);

    const previewDurations = Array.from({ length: 120 }, () => {
      const previewStarted = performance.now();
      const preview = session.update({ x: 2, y: 3 });
      const duration = performance.now() - previewStarted;
      expect(preview).toMatchObject({ exactElements: [], exactPreviewTruncated: true });
      return duration;
    });
    const preview = session.update({ x: 2, y: 3 });
    expect(preview).toMatchObject({ exactElements: [], exactPreviewTruncated: true });
    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });

    const scheduler = new MeasuredSliceScheduler(2);
    const materialized = await session.prepareCommitTimeSliced(scheduler);
    if (materialized.status !== "ready") throw new Error("Expected transformed targets.");
    const prepared = await store.prepareElementReplacement(materialized.replacements, scheduler);
    scheduler.finish();
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    const commit = store.commitPreparedElementReplacement(prepared.token);

    expect(commit.status).toBe("committed");
    expect(commit.delta?.changes).toHaveLength(elements.length);
    expect(store.get(elements[39]!.id)?.element).toMatchObject({ start: { x: 23, y: 24 } });
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 19_929,
    });
    expect(interactionP99(previewDurations)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(percentile(scheduler.sliceDurations, 0.95)).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms),
    );
    expect(scheduler.maxSliceDuration).toBeLessThanOrEqual(
      timingBudget(INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs),
    );
  }, 30_000);
});

function movedSession(strokes: readonly StrokeElementV1[]): SelectionHandleSession {
  const session = createPassThroughMoveSession(strokes, { x: 0, y: 0 });
  session.update({ x: 2, y: 3 });
  return session;
}

function measureCommitDecisions(session: SelectionHandleSession): number[] {
  const durations: number[] = [];
  for (let run = 0; run < 121; run += 1) {
    const started = performance.now();
    const decision = session.prepareCommit();
    const duration = performance.now() - started;
    expect(decision).toEqual({ status: "time-sliced-required" });
    if (run > 0) durations.push(duration);
  }
  return durations;
}

function measureIndexedMisses(strokes: readonly StrokeElementV1[]): number[] {
  const sceneStore = new ElementSceneStore(
    new ElementStore(strokes.map((stroke) => ({ ...stroke, points: Array.from(stroke.points) }))),
  );
  const durations: number[] = [];
  try {
    sceneStore.hit({ x: 2_048, y: 50 }, "mouse", 1);
    for (let run = 0; run < 100; run += 1) {
      const started = performance.now();
      expect(sceneStore.hit({ x: 2_048, y: 50 }, "mouse", 1)).toBeNull();
      durations.push(performance.now() - started);
    }
  } finally {
    sceneStore.release();
  }
  return durations;
}

async function prepareInMeasuredSlices(session: SelectionHandleSession): Promise<{
  readonly maximumSlice: number;
  readonly prepared: TimeSlicedSelectionCommitPreparation;
  readonly sliceDurations: readonly number[];
}> {
  let sliceStarted = performance.now();
  let maximumSlice = 0;
  const sliceDurations: number[] = [];
  const prepared = await session.prepareCommitTimeSliced({
    shouldYield: () => true,
    yieldControl: async () => {
      const duration = performance.now() - sliceStarted;
      sliceDurations.push(duration);
      maximumSlice = Math.max(maximumSlice, duration);
      sliceStarted = performance.now();
    },
  });
  const duration = performance.now() - sliceStarted;
  sliceDurations.push(duration);
  maximumSlice = Math.max(maximumSlice, duration);
  return { maximumSlice, prepared, sliceDurations };
}

function maximumEndpointFixture(): {
  readonly elements: readonly InkElementV1[];
  readonly targetIds: readonly string[];
} {
  const targetCount = 39;
  const endpointsPerTarget = 511;
  const targets = Array.from({ length: targetCount }, (_, index) => endpointTarget(index));
  const lines = targets.flatMap((target, targetIndex) =>
    Array.from({ length: endpointsPerTarget }, (_, endpointIndex) =>
      endpointLine(target, targetCount + targetIndex * endpointsPerTarget + endpointIndex),
    ),
  );
  return { elements: [...targets, ...lines], targetIds: targets.map(({ id }) => id) };
}

async function warmEndpointPreparation(
  store: ElementStore,
  targetIds: readonly string[],
): Promise<void> {
  const session = endpointSession(store, targetIds);
  session.update({ x: 1, y: 1 });
  const scheduler = new MeasuredSliceScheduler(2);
  const materialized = await session.prepareCommitTimeSliced(scheduler);
  if (materialized.status !== "ready") throw new Error("Expected warm-up targets.");
  const preparation = await store.prepareElementReplacement(materialized.replacements, scheduler);
  if (preparation.token === null) throw new Error("Expected a warm-up replacement token.");
  if (store.commitPreparedElementReplacement(preparation.token).status !== "committed") {
    throw new Error("Expected the warm-up replacement to commit.");
  }
}

function endpointSession(
  store: ElementStore,
  targetIds: readonly string[],
): SelectionHandleSession {
  const targets = targetIds.map((id) => store.get(id)!.element as InkElementV1);
  const session = new SelectionHandleSession({
    action: { kind: "move" },
    elements: targets,
    planner: store,
    startPointer: { x: 0, y: 0 },
  });
  return session;
}

function endpointTarget(index: number): BoxShapeElementV1 {
  const x = 20 + (index % 8) * 220;
  const y = 20 + Math.floor(index / 8) * 150;
  return {
    createdAt: index,
    height: 100,
    id: fixtureId(index),
    kind: "rectangle",
    pivot: { x: x + 100, y: y + 50 },
    rotation: 0,
    style: { ...outlineStyle(), fillColor: null, fillOpacity: 0 },
    width: 200,
    x,
    y,
  };
}

function maximumViewportStroke(index: number): StrokeElementV1 {
  const source = maximumStroke(index);
  const points = new Float64Array(source.points.length);
  for (let offset = 0; offset < points.length; offset += 3) {
    points[offset] = 2 + ((offset / 3) % 2_044);
    points[offset + 1] = 100 + index * 0.001;
    points[offset + 2] = 0.5;
  }
  return {
    ...source,
    pivot: { x: 1_024, y: 100 + index * 0.001 },
    points: points as unknown as StrokeElementV1["points"],
  };
}

function endpointLine(target: BoxShapeElementV1, index: number): LineElementV1 {
  return {
    ...connectedLine(target),
    createdAt: index,
    id: fixtureId(index),
    style: outlineStyle(),
  };
}

function outlineStyle() {
  return {
    outlineColor: { type: "theme-text" as const },
    outlineOpacity: 1,
    outlineStyle: "solid" as const,
    outlineWidth: 2 as const,
  };
}

function fixtureId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}
