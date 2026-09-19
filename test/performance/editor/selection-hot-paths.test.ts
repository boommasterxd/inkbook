import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../src/domain/geometry/public";
import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import type { TimeSlicedSelectionCommitPreparation } from "../../../src/editor/selection/handle-session";
import {
  createRectangleSelectionArea,
  SelectionHandleSession,
  selectBySelectionAreaQuery,
  type SelectionArea,
} from "../../../src/editor/selection/public";
import {
  createLassoSelectionArea,
  type SelectionAreaInclusion,
} from "../../../src/editor/selection/selection-area";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";

import { CheckpointSliceScheduler } from "../domain/domain-scenarios";
import { rectangle } from "../../unit/domain/schema/fixtures";
import { indexedStroke } from "../../fixtures/editor/stroke";
import {
  endpointSession,
  maximumEndpointFixture,
  observeEndpointPreparation,
} from "../../fixtures/editor/endpoint-fanout";
import { maximumStroke } from "./maximum-stroke-fixture";
import { createPassThroughMoveSession } from "./selection-session-fixture";
import type { SelectionHandleSessionOptions } from "../../../src/editor/selection/handle-types";
import type { TransformSliceScheduler } from "../../../src/editor/selection/transforms";

function maximumViewportStroke(index: number): StrokeElementV1 {
  const points = new Float64Array(4_096 * 3);
  for (let offset = 0; offset < points.length; offset += 3) {
    points[offset] = 2 + ((offset / 3) % 2_044);
    points[offset + 1] = 100 + index * 0.001;
    points[offset + 2] = 0.5;
  }
  return {
    ...maximumStroke(index, points as unknown as StrokeElementV1["points"]),
    pivot: { x: 1_024, y: 100 + index * 0.001 },
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
  expect(store.get(firstLineId)?.element).toMatchObject({ start: { x: 22, y: 23 } });
  expect(store.instrumentation).toMatchObject({
    bandScans: 0,
    fullStoreScans: 0,
    snapshotMaterializations: 0,
    publishedDeltas: 1,
    recordReplacements: 19_968,
    deltaEntries: 19_968,
    timeSlicedIndexVisits: 39_897,
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

describe("selection hot paths", () => {
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
      store.resetInstrumentation();
      verifyAreaSelection(store, sceneStore, lasso, "touched");
      verifyAreaSelection(store, sceneStore, lasso, "fully-enclosed");
      verifyAreaSelection(store, sceneStore, rectangle, "touched");

      expect(store.instrumentation.fullStoreScans).toBe(0);
    } finally {
      sceneStore.release();
    }
  });
});

describe("selection scale preview hot path", () => {
  it("keeps a tight 10,000-stroke scale frame off the linear pointer path", () => {
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
    const session = new SelectionHandleSession(
      scaleSessionOptions(elements, store, { minX, minY, maxX, maxY }),
    );
    for (let frame = 0; frame < 3; frame += 1) {
      const preview = session.update({ x: maxX + frame + 1, y: maxY + (frame + 1) / 2 });
      expect(preview.previewFrame?.points[0]?.x).toBeCloseTo(minX, 3);
      expect(preview.previewFrame?.points[0]?.y).toBeCloseTo(minY, 3);
      expect(preview.previewFrame?.points[2]?.x).toBeCloseTo(maxX + frame + 1, 3);
      expect(preview.previewFrame?.points[2]?.y).toBeCloseTo(maxY + (frame + 1) / 2, 3);
    }
  });
});

describe("selection commit hot paths", () => {
  it("routes 488 maximum strokes through the indexed hit path and bounded commit slices", async () => {
    const strokes = Array.from({ length: 488 }, (_, index) => maximumViewportStroke(index));
    const session = movedSession(strokes);

    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
    verifyIndexedMiss(strokes);
    const prepared = await prepareInBoundedSlices(session);

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected an exact time-sliced commit.");
    const first = prepared.replacements[0];
    const last = prepared.replacements[prepared.replacements.length - 1];
    if (first?.kind !== "stroke" || last?.kind !== "stroke") {
      throw new Error("Expected maximum-stroke replacements.");
    }
    expect(first.points.slice(0, 3)).toEqual(new Float64Array([4, 103, 0.5]));
    expect(last.points.slice(-3)).toEqual(new Float64Array([11, 103.487, 0.5]));
  });

  it("bounds preparation for a near-maximum 19,929-endpoint selection fan-out", async () => {
    const { elements, targetIds } = maximumEndpointFixture();
    const store = new ElementStore(elements);
    store.resetInstrumentation();
    const session = endpointSession(store, targetIds);

    const preview = session.update({ x: 2, y: 3 });
    expect(preview).toMatchObject({ exactElements: [], exactPreviewTruncated: true });
    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });

    const scheduler = new CheckpointSliceScheduler(40);
    const prepared = await prepareEndpointFanout(store, session, scheduler);
    scheduler.finish();
    expect(Math.max(...scheduler.checkpointCounts)).toBeLessThanOrEqual(40);
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    const commit = store.commitPreparedElementReplacement(prepared.token);

    expect(commit.status).toBe("committed");
    expect(commit.delta?.changes).toHaveLength(elements.length);
    verifyEndpointFanout(store, elements[39]!.id);
  }, 30_000);

  it("bounds observed fan-out preparation work between yields without publishing partial state", async () => {
    const { elements, targetIds } = maximumEndpointFixture();
    const store = new ElementStore(elements);
    const session = endpointSession(store, targetIds);
    session.update({ x: 2, y: 3 });
    store.resetInstrumentation();
    const observation = observeEndpointPreparation(store);
    try {
      const prepared = await prepareEndpointFanout(store, session, observation.scheduler);
      const work = observation.finish();
      expect(work.creations).toBe(elements.length);
      expect(work.maximumCreationsBetweenYields).toBe(1);
      expect(work.maximumReverseVisitsBetweenYields).toBe(1);
      expect(work.yields).toBeGreaterThanOrEqual(elements.length);
      expect(work.partialPublications).toBe(0);
      expect(store.instrumentation).toMatchObject({
        bandScans: 0,
        fullStoreScans: 0,
        snapshotMaterializations: 0,
        recordReplacements: 0,
        publishedDeltas: 0,
        reverseDependencyVisits: 19_929,
      });
      if (prepared.token === null) throw new Error("Expected complete fan-out preparation.");
      const commit = store.commitPreparedElementReplacement(prepared.token);
      expect(commit.status).toBe("committed");
      expect(commit.delta?.changes).toHaveLength(elements.length);
      expect(new Set(commit.delta?.changes.map(({ id }) => id)).size).toBe(elements.length);
    } finally {
      observation.restore();
    }
  }, 30_000);
});

function movedSession(strokes: readonly StrokeElementV1[]): SelectionHandleSession {
  const session = createPassThroughMoveSession(strokes, { x: 0, y: 0 });
  session.update({ x: 2, y: 3 });
  return session;
}

function verifyIndexedMiss(strokes: readonly StrokeElementV1[]): void {
  const store = new ElementStore(
    strokes.map((stroke) => ({ ...stroke, points: Array.from(stroke.points) })),
  );
  const sceneStore = new ElementSceneStore(store);
  store.resetInstrumentation();
  try {
    expect(sceneStore.hit({ x: 2_048, y: 50 }, "mouse", 1)).toBeNull();
    expect(store.instrumentation.fullStoreScans).toBe(0);
  } finally {
    sceneStore.release();
  }
}

async function prepareInBoundedSlices(
  session: SelectionHandleSession,
): Promise<TimeSlicedSelectionCommitPreparation> {
  let yields = 0;
  const prepared = await session.prepareCommitTimeSliced({
    shouldYield: () => true,
    yieldControl: async () => {
      yields += 1;
    },
  });
  expect(yields).toBeGreaterThanOrEqual(488);
  return prepared;
}

function verifyAreaSelection(
  store: ElementStore,
  sceneStore: ElementSceneStore,
  area: SelectionArea,
  inclusion: SelectionAreaInclusion,
): void {
  expect(selectInArea(store, sceneStore, area, inclusion).size).toBe(1_000);
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
