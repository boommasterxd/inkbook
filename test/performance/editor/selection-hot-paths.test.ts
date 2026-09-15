import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../src/domain/geometry/public";
import type {
  BoxShapeElementV1,
  InkElementV1,
  LineElementV1,
  StrokeElementV1,
} from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import type { TimeSlicedSelectionCommitPreparation } from "../../../src/editor/selection/handle-session";
import {
  createRectangleSelectionArea,
  LassoSelectionSession,
  SelectionHandleSession,
  selectBySelectionAreaQuery,
  selectionOverlayContainsPoint,
  selectionOverlayGeometry,
  type SelectionArea,
} from "../../../src/editor/selection/public";
import {
  createLassoSelectionArea,
  elementMatchesSelectionArea,
  type SelectionAreaInclusion,
} from "../../../src/editor/selection/selection-area";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";

import { MeasuredSliceScheduler, percentile } from "../domain/domain-scenarios";
import { rectangle } from "../../unit/domain/schema/fixtures";
import { connectedLine } from "../../unit/domain/store/fixtures";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { maximumStroke } from "./maximum-stroke-fixture";
import { createPassThroughMoveSession } from "./selection-session-fixture";
import { INTERACTION_REFRESH_PROFILE, interactionP99 } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";
import type { SelectionHandleSessionOptions } from "../../../src/editor/selection/handle-types";
import type { TransformSliceScheduler } from "../../../src/editor/selection/transforms";

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

function scaleSessionOptions(
  elements: readonly InkElementV1[],
  planner: ElementStore,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): SelectionHandleSessionOptions {
  return {
    action: {
      anchor: { x: bounds.minX, y: bounds.minY },
      kind: "scale",
      position: "bottom-right",
      rotation: 0,
    },
    elements,
    planner,
    startPointer: { x: bounds.maxX, y: bounds.maxY },
  };
}

function verifyEndpointFanout(store: ElementStore, firstLineId: string): void {
  expect(store.get(firstLineId)?.element).toMatchObject({ start: { x: 23, y: 24 } });
  expect(store.instrumentation).toMatchObject({
    fullStoreScans: 0,
    reverseDependencyVisits: 19_929,
  });
}

async function prepareEndpointFanout(
  store: ElementStore,
  session: SelectionHandleSession,
  scheduler: TransformSliceScheduler,
) {
  const materialized = await session.prepareCommitTimeSliced(scheduler);
  if (materialized.status !== "ready") throw new Error("Expected transformed targets.");
  return store.prepareElementReplacement(materialized.replacements, scheduler);
}

describe("pressure selection hot path", () => {
  it("stops pressure sweep selection at the first visible segment of a maximum stroke", () => {
    const target = maximumStroke(0);
    const area = createRectangleSelectionArea({ x: -1, y: 99 }, { x: 1, y: 101 });
    for (let index = 0; index < 20; index += 1) {
      elementMatchesSelectionArea(area, target, "touched");
    }
    const durations = Array.from({ length: 120 }, () => {
      const started = performance.now();
      const selected = elementMatchesSelectionArea(area, target, "touched");
      const duration = performance.now() - started;
      expect(selected).toBe(true);
      return duration;
    });

    expectTiming(interactionP99(durations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  });
});

describe("selection hot paths", () => {
  it("reduces a maximum coalesced lasso batch within one interaction budget", () => {
    const samples = Array.from({ length: 4_096 }, (_, index) => ({
      x: index * 2,
      y: 40 + Math.sin(index / 12) * 24,
    }));
    new LassoSelectionSession({ x: 0, y: 40 }, 1).appendBatch(samples);
    const durations = Array.from({ length: 120 }, () => {
      const session = new LassoSelectionSession({ x: 0, y: 40 }, 1);
      const started = performance.now();
      session.appendBatch(samples);
      const duration = performance.now() - started;
      expect(session.points.length).toBeLessThanOrEqual(512);
      return duration;
    });

    expectTiming(interactionP99(durations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  });

  it("classifies rectangle and bounded lasso candidates in a 10,000-stroke index", () => {
    const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
    const store = new ElementStore(elements);
    const sceneStore = new ElementSceneStore(store);
    const lasso = createLassoSelectionArea([
      { x: 15, y: 15 },
      { x: 1_015, y: 15 },
      { x: 1_015, y: 115 },
      { x: 15, y: 115 },
    ]);
    const rectangle = createRectangleSelectionArea({ x: 15, y: 15 }, { x: 1_015, y: 115 });
    try {
      selectInArea(store, sceneStore, lasso, "touched");
      selectInArea(store, sceneStore, lasso, "fully-enclosed");
      selectInArea(store, sceneStore, rectangle, "touched");
      store.resetInstrumentation();
      const touchedDurations = measureAreaSelection(store, sceneStore, lasso, "touched");
      const enclosedDurations = measureAreaSelection(store, sceneStore, lasso, "fully-enclosed");
      const rectangleDurations = measureAreaSelection(store, sceneStore, rectangle, "touched");

      expectTiming(interactionP99(touchedDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
      expectTiming(interactionP99(enclosedDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
      expectTiming(interactionP99(rectangleDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
      expect(store.instrumentation.fullStoreScans).toBe(0);
    } finally {
      sceneStore.release();
    }
  });

  it("keeps the 10,000-stroke group overlay within the interaction budget", () => {
    const selected = Array.from({ length: 10_000 }, (_, index) => {
      const element = indexedStroke(index);
      return { bounds: calculateElementBounds(element), element };
    });
    selectionOverlayGeometry(selected, 1);
    const durations = Array.from({ length: 120 }, () => {
      const started = performance.now();
      const geometry = selectionOverlayGeometry(selected, 1);
      const duration = performance.now() - started;
      expect(geometry?.outline.kind).toBe("polygon");
      expect(geometry?.handles).toHaveLength(9);
      return duration;
    });
    const center = { x: 1_000, y: 100 };
    selectionOverlayContainsPoint(selected, center);
    const hitDurations = Array.from({ length: 120 }, () => {
      const started = performance.now();
      expect(selectionOverlayContainsPoint(selected, center)).toBe(true);
      return performance.now() - started;
    });

    expectTiming(interactionP99(durations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(interactionP99(hitDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  });
});

describe("selection scale preview hot path", () => {
  it("keeps a tight 10,000-stroke scale frame off the linear pointer path", async ({
    annotate,
  }) => {
    const elements = [
      ...Array.from({ length: 10_000 }, (_, index) => indexedStroke(index)),
      ...Array.from({ length: 256 }, (_, index) => ({
        ...rectangle(20_001 + index),
        rotation: 37,
      })),
    ];
    const bounds = elements.map(calculateElementBounds);
    const minX = Math.min(...bounds.map(({ minX: value }) => value));
    const minY = Math.min(...bounds.map(({ minY: value }) => value));
    const maxX = Math.max(...bounds.map(({ maxX: value }) => value));
    const maxY = Math.max(...bounds.map(({ maxY: value }) => value));
    const store = new ElementStore(elements);
    const started = performance.now();
    const session = new SelectionHandleSession(
      scaleSessionOptions(elements, store, { minX, minY, maxX, maxY }),
    );
    const setupDuration = performance.now() - started;
    const durations = Array.from({ length: 120 }, (_, frame) => {
      const pointerStarted = performance.now();
      const preview = session.update({ x: maxX + frame + 1, y: maxY + (frame + 1) / 2 });
      const duration = performance.now() - pointerStarted;
      expect(preview.previewFrame?.points[0]?.x).toBeCloseTo(minX, 3);
      expect(preview.previewFrame?.points[0]?.y).toBeCloseTo(minY, 3);
      expect(preview.previewFrame?.points[2]?.x).toBeCloseTo(maxX + frame + 1, 3);
      expect(preview.previewFrame?.points[2]?.y).toBeCloseTo(maxY + (frame + 1) / 2, 3);
      return duration;
    });

    expectTiming(setupDuration, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
    const p99 = interactionP99(durations);
    await annotate(
      `10,000 strokes and 256 rotated boxes: scale preview p99=${p99.toFixed(3)} ms`,
      "performance",
    );
    expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
  });
});

describe("selection commit hot paths", () => {
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
    expectTiming(interactionP99(decisionDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(interactionP99(hitDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(percentile(sliceDurations, 0.95), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(maximumSlice, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
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
    const prepared = await prepareEndpointFanout(store, session, scheduler);
    scheduler.finish();
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    const commit = store.commitPreparedElementReplacement(prepared.token);

    expect(commit.status).toBe("committed");
    expect(commit.delta?.changes).toHaveLength(elements.length);
    verifyEndpointFanout(store, elements[39]!.id);
    expectTiming(interactionP99(previewDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(
      percentile(scheduler.sliceDurations, 0.95),
      INTERACTION_REFRESH_PROFILE.mainThreadP99Ms,
    );
    expectTiming(scheduler.maxSliceDuration, INTERACTION_REFRESH_PROFILE.atomicCommitMaxMs);
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

function measureAreaSelection(
  store: ElementStore,
  sceneStore: ElementSceneStore,
  area: SelectionArea,
  inclusion: SelectionAreaInclusion,
): number[] {
  return Array.from({ length: 120 }, () => {
    const started = performance.now();
    const selection = selectInArea(store, sceneStore, area, inclusion);
    const duration = performance.now() - started;
    expect(selection.size).toBe(1_000);
    return duration;
  });
}

function selectInArea(
  store: ElementStore,
  sceneStore: ElementSceneStore,
  area: SelectionArea,
  inclusion: SelectionAreaInclusion,
): ReadonlySet<string> {
  return selectBySelectionAreaQuery(new Set(), area, inclusion, false, (bounds, sink) =>
    sceneStore.query(bounds, {
      add: (id) => {
        const record = store.get(id);
        if (record !== undefined) {
          sink.add(id, record.bounds, record.element as InkElementV1);
        }
      },
    }),
  );
}
