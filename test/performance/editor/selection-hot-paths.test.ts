import { createHook } from "node:async_hooks";
import * as geometryBounds from "../../../src/domain/geometry/public";
import { calculateElementBounds } from "../../../src/domain/geometry/public";
import { elementMatchesSelectionAreaSteps } from "../../../src/editor/selection/selection-area";

import * as strokePosition from "../../../src/domain/geometry/stroke-position";
import * as pressureUnion from "../../../src/domain/geometry/pressure-union";
import { strokePrimitiveSteps } from "../../../src/editor/selection/stroke-selection-geometry";
import { activeActions } from "../../fixtures/obsidian/editor-actions";
import { createClipboardDocumentModel } from "../../integration/obsidian/embeds/active-editor-clipboard-fixtures";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import { selectBySelectionAreaQuery } from "../../fixtures/editor/selection-query";
import { describe, expect, it, vi } from "vitest";

import { selectionCenterlineBounds } from "../../../src/editor/selection/centerline-bounds";
import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import {
  createRectangleSelectionArea,
  SelectionHandleSession,
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

it("avoids pressure geometry builds for repeated gap lassos on a positioned 10,000-point stroke", () => {
  const offset = { x: -1_000, y: 200 };
  const corners = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  const points = Array.from({ length: 10_000 }, (_, index) => [
    ...corners[index < 4 ? index : 0]!,
    1,
  ]).flat();
  const target = strokePosition.translatedStroke(maximumStroke(0, points), offset);
  const area = createLassoSelectionArea([
    { x: -951, y: 249 },
    { x: -949, y: 249 },
    { x: -949, y: 251 },
    { x: -951, y: 251 },
  ]);
  const bounds = calculateElementBounds(target);
  const build = vi.spyOn(pressureUnion, "iteratePressureUnion");
  try {
    Array.from(strokePrimitiveSteps(target, { bounds: area.bounds }));
    expect(build).toHaveBeenCalled();
    build.mockClear();
    for (let query = 0; query < 3; query += 1) {
      const steps = elementMatchesSelectionAreaSteps(area, target, "touched", bounds);
      let result = steps.next();
      while (!result.done) result = steps.next();
      expect(result.value).toBe(false);
    }
    expect(build).not.toHaveBeenCalled();
  } finally {
    build.mockRestore();
  }
});

function denseViewportStroke(index: number): StrokeElementV1 {
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
    reverseDependencyVisits: 0,
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
    const bounds = elements.map((element) => selectionCenterlineBounds(element));
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
  it("does not allocate a Promise per element for a 10,000-stroke move without yields", async () => {
    const strokes = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
    const session = movedSession(strokes);
    let promises = 0;
    let checks = 0;
    let yields = 0;
    const hook = createHook({
      init: (_id, type) => {
        if (type === "PROMISE") promises += 1;
      },
    });
    hook.enable();
    let prepared: Awaited<ReturnType<typeof session.prepareCommitTimeSliced>>;
    try {
      prepared = await session.prepareCommitTimeSliced({
        shouldYield: () => {
          checks += 1;
          return false;
        },
        yieldControl: async () => {
          yields += 1;
        },
      });
    } finally {
      hook.disable();
    }
    expect(prepared.status).toBe("ready");
    expect(checks).toBe(strokes.length);
    expect(yields).toBe(0);
    // Fixed async entry/return overhead is allowed; per-element Promises are not.
    expect(promises).toBeLessThanOrEqual(32);
  });

  it("moves 488 dense strokes synchronously without reading unchanged samples", () => {
    const strokes = Array.from({ length: 488 }, (_, index) => denseViewportStroke(index));
    verifyIndexedMiss(strokes);
    let sampleReads = 0;
    const observed = strokes.map((stroke) => ({
      ...stroke,
      points: new Proxy(stroke.points, {
        get: (source, key) => {
          if (typeof key === "string" && /^\d+$/.test(key)) sampleReads += 1;
          const value: unknown = Reflect.get(source, key, source);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            sampleReads += source.length;
            return Reflect.apply(value, source, args) as unknown;
          };
        },
      }),
    }));
    const prepared = movedSession(observed).prepareCommit();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected synchronous position commit.");
    expect(prepared.replacements).toHaveLength(strokes.length);
    for (let index = 0; index < observed.length; index += 1) {
      const replacement = prepared.replacements[index]!;
      if (replacement.kind !== "stroke") throw new Error("Expected stroke replacement.");
      expect(replacement.points).toBe(observed[index]!.points);
      expect(replacement.offset).toEqual({ x: 2, y: 3 });
      expect(replacement.pivot.x).toBe(1026);
    }
    expect(sampleReads).toBe(0);
  });

  it("slices and cancels moves according to element count instead of sample count", async () => {
    const strokes = Array.from({ length: 1_001 }, (_, index) => indexedStroke(index));
    const session = movedSession(strokes);
    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
    const translate = vi.spyOn(strokePosition, "translatedStroke");
    try {
      let previousCalls = 0;
      const prepared = await session.prepareCommitTimeSliced({
        shouldYield: () => true,
        yieldControl: async () => {
          expect(translate.mock.calls.length - previousCalls).toBeLessThanOrEqual(1);
          previousCalls = translate.mock.calls.length;
        },
      });
      expect(prepared.status).toBe("ready");
      expect(translate).toHaveBeenCalledTimes(strokes.length);
      const cancelledSession = movedSession(strokes);
      let cancelled = false;
      translate.mockClear();
      const abandoned = await cancelledSession.prepareCommitTimeSliced({
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      });
      expect(abandoned.status).toBe("cancelled");
      expect(translate.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      translate.mockRestore();
    }
  });
});

describe("selection connection fan-out commits", () => {
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
      expect(work.reverseVisits).toBe(19_929);
      expect(work.maximumReverseVisitsBetweenYields).toBe(1);
      expect(work.yields).toBeGreaterThanOrEqual(elements.length);
      expect(work.partialPublications).toBe(0);
      expect(store.instrumentation).toMatchObject({
        bandScans: 0,
        fullStoreScans: 0,
        snapshotMaterializations: 0,
        recordReplacements: 0,
        publishedDeltas: 0,
        reverseDependencyVisits: 0,
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

it("performs no selection member scans during repeated deletion cancellation checks", async () => {
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const selection = new Set(elements.map(({ id }) => id));
  const prepareElementMutation = vi.fn<EditableDocumentModel["prepareElementMutation"]>(
    async (_mutation, cancellation) => {
      const iterate = vi.spyOn(selection, Symbol.iterator);
      const has = vi.spyOn(selection, "has");
      try {
        for (let checkpoint = 0; checkpoint < 10_000; checkpoint += 1) {
          expect(cancellation?.isCancelled()).toBe(false);
        }
        expect(iterate).not.toHaveBeenCalled();
        expect(has).not.toHaveBeenCalled();
      } finally {
        iterate.mockRestore();
        has.mockRestore();
      }
      return { status: "noop", token: null };
    },
  );
  const model = createClipboardDocumentModel({
    store: new ElementStore(elements),
    prepareElementMutation,
    commitPreparedElementMutation: vi.fn(() => null),
    planClipboardPaste: vi.fn(async () => null),
  });
  const actions = activeActions(
    model,
    new ElementSceneStore(model.store),
    { navigator: {} } as Window,
    vi.fn(),
    selection,
  );
  try {
    actions.execute("delete");
    await vi.waitFor(() => expect(prepareElementMutation).toHaveBeenCalledOnce());
    await prepareElementMutation.mock.results[0]!.value;
  } finally {
    actions.dispose();
  }
});

it("avoids stroke geometry for diagonal lasso edge-box false positives at capacity", () => {
  const area = createLassoSelectionArea([
    { x: 0, y: 0 },
    { x: 1000, y: 1000 },
    { x: 1000, y: 0 },
    { x: 0, y: 1000 },
  ]);
  let pointReads = 0;
  let candidateBoundReads = 0;
  const edgeCheck = vi.spyOn(geometryBounds, "boundsIntersect");
  try {
    for (let index = 0; index < 10_000; index += 1) {
      const source = indexedStroke(index);
      const bounds = calculateElementBounds(source);
      const observedBounds = {
        get minX() {
          candidateBoundReads += 1;
          return bounds.minX;
        },
        get minY() {
          candidateBoundReads += 1;
          return bounds.minY;
        },
        get maxX() {
          candidateBoundReads += 1;
          return bounds.maxX;
        },
        get maxY() {
          candidateBoundReads += 1;
          return bounds.maxY;
        },
      };
      const points = new Proxy(source.points, {
        get(target, key, receiver): unknown {
          if (typeof key === "string" && /^\d+$/.test(key)) pointReads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const steps = elementMatchesSelectionAreaSteps(
        area,
        { ...source, points },
        "touched",
        observedBounds,
      );
      let result = steps.next();
      while (!result.done) result = steps.next();
    }
    const edgeBoxes = edgeCheck.mock.calls.filter(([left]) => "start" in left).length;
    expect(edgeBoxes).toBeGreaterThan(10_000);
    expect(edgeBoxes).toBeLessThan(100_000);
    expect(candidateBoundReads).toBeGreaterThan(edgeBoxes);
    expect(candidateBoundReads).toBeLessThan(300_000);
    expect(pointReads).toBeGreaterThan(0);
    expect(pointReads).toBeLessThan(5_000);
  } finally {
    edgeCheck.mockRestore();
  }
});
