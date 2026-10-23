import { MAX_STROKE_POINTS } from "../../../src/domain/schema/public";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import * as svgFormat from "../../../src/domain/geometry/svg-format";
import {
  visitVisibleElementPrimitives,
  type SelectionPrimitiveVisitor,
} from "../../../src/editor/selection/query/element-selection-geometry";
import { arrow } from "../../unit/domain/schema/fixtures";

import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { SpatialQueryScratch, UniformSpatialIndex } from "../../../src/domain/spatial/index";
import { ElementStore } from "../../../src/domain/store/public";
import { elementContainsPoint, HitTestScratch } from "../../../src/editor/selection/query/hit-test";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transform/transforms";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import {
  findSnapCandidate,
  SnapCandidateScratch,
  type SpatialCandidateQuery,
  type SpatialCandidateSink,
  type SnapTargetReader,
} from "../../../src/editor/snapping/snap-candidate";

import {
  createDenseSnapTargets,
  createStandardRuntimeDomainFixture,
  type StandardDomainFixture,
} from "./standard-domain-fixture";
import {
  createNoopHistoryModel,
  exerciseTransformRun,
  observeSpatialQueryWork,
  requireStroke,
} from "./domain-scenarios";
import { indexedStroke } from "../../fixtures/editor/stroke";
let fixture: StandardDomainFixture;
let store: ElementStore;

it("bounds rounded arrow construction to eight arcs and eleven exact selection primitives", () => {
  const target = { ...arrow(), startNode: "diamond" as const, endNode: "diamond" as const };
  const curves = vi.spyOn(svgFormat, "arcTo");
  const samples = vi.spyOn(Math, "cos");
  try {
    buildElementPathParts(target);
    expect(curves).toHaveBeenCalledTimes(8);
    samples.mockClear();
    const visit = vi.fn<SelectionPrimitiveVisitor>(() => true);
    visitVisibleElementPrimitives(target, visit);
    expect(visit).toHaveBeenCalledTimes(11);
    const polygons = visit.mock.calls.flatMap(([primitive]) =>
      primitive.kind === "polygon" ? [primitive.points.length] : [],
    );
    expect(polygons).toEqual([4, 4]);
    expect(samples).not.toHaveBeenCalled();
    const reject = vi.fn(() => false);
    visitVisibleElementPrimitives(target, reject);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(samples).not.toHaveBeenCalled();
  } finally {
    curves.mockRestore();
    samples.mockRestore();
  }
});

it.each([1_000, 10_000])("keeps local index work bounded with %i unrelated strokes", (count) => {
  const local = Array.from({ length: 8 }, (_, index) => indexedStroke(index));
  const unrelated = Array.from({ length: count }, (_, index) => indexedStroke(index + 10_000));
  const indexed = new ElementStore([...local, ...unrelated]);
  const scratch = new SpatialQueryScratch<string>();
  const bounds = { minX: 19, maxX: 92, minY: 19, maxY: 21 };
  indexed.query(bounds, scratch);
  const warmAllocations = scratch.allocationCount;
  indexed.resetInstrumentation();
  for (let query = 0; query < 3; query += 1) {
    expect(indexed.query(bounds, scratch)).toBe(local.length);
    expect(scratch.candidateVisitCount).toBeLessThanOrEqual(local.length);
    expect(scratch.duplicateVisitCount).toBe(0);
    expect(scratch.allocationCount).toBe(warmAllocations);
    expect(new Set(Array.from({ length: scratch.count }, (_, index) => scratch.at(index)))).toEqual(
      new Set(local.map(({ id }) => id)),
    );
  }
  expect(indexed.instrumentation).toMatchObject({
    fullStoreScans: 0,
    bandScans: 0,
    snapshotMaterializations: 0,
    recordReplacements: 0,
  });
  scratch.release();
});

it.each([
  { axis: "columns", count: 1_000 },
  { axis: "columns", count: 10_000 },
  { axis: "rows", count: 1_000 },
  { axis: "rows", count: 10_000 },
])("bounds anisotropic queries among $count unrelated $axis", ({ axis, count }) => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(
    Array.from({ length: count }, (_, id) => ({
      id,
      bounds: {
        minX: axis === "columns" ? id * 256 + 1 : 1,
        maxX: axis === "columns" ? id * 256 + 2 : 2,
        minY: axis === "rows" ? id * 256 + 1 : 1,
        maxY: axis === "rows" ? id * 256 + 2 : 2,
      },
    })),
  );
  const bounds = {
    minX: 1,
    maxX: axis === "rows" ? 10_001 * 256 : 2,
    minY: 1,
    maxY: axis === "columns" ? 10_001 * 256 : 2,
  };
  const observed = observeSpatialQueryWork(index, vi.spyOn);
  const scratch = new SpatialQueryScratch<number>();
  try {
    expect(index.query(bounds, scratch)).toBe(1);
    expect(scratch.at(0)).toBe(0);
    expect(observed.counts).toEqual({ columns: 1, cells: 1, slots: 1 });
    expect(observed.comparisons()).toBeGreaterThan(0);
    expect(observed.comparisons()).toBeLessThanOrEqual(3 * observed.comparisonsPerLookupBound);
    observed.reset();
    const cursor = index.beginQuery(bounds);
    const ids: number[] = [];
    let done = false;
    for (let advance = 0; advance < 12 && !done; advance += 1) {
      const before = { ...observed.counts };
      const step = cursor.advance(1);
      expect(step.workUnits).toBeLessThanOrEqual(1);
      expect(
        Object.values(observed.counts).reduce((sum, value) => sum + value, 0),
      ).toBeLessThanOrEqual(Object.values(before).reduce((sum, value) => sum + value, 0) + 1);
      ids.push(...step.ids);
      done = step.done;
    }
    expect(done).toBe(true);
    expect(ids).toEqual([0]);
    expect(observed.counts).toEqual({ columns: 1, cells: 1, slots: 1 });
    expect(observed.comparisons()).toBeLessThanOrEqual(3 * observed.comparisonsPerLookupBound);
    expect(cursor.memoryUsage()).toBe(0);
  } finally {
    observed.restore();
    scratch.release();
  }
});

it("retains dense 10,000-element lookup and cursor admission bounds", () => {
  const index = new UniformSpatialIndex<number>();
  index.insertMany(
    Array.from({ length: 10_000 }, (_, id) => ({
      id,
      bounds: {
        minX: (id % 100) * 512 + 1,
        maxX: (id % 100) * 512 + 2,
        minY: Math.floor(id / 100) * 512 + 1,
        maxY: Math.floor(id / 100) * 512 + 2,
      },
    })),
  );
  const bounds = { minX: 0, minY: 0, maxX: 2_100, maxY: 2_100 };
  const observed = observeSpatialQueryWork(index, vi.spyOn);
  const scratch = new SpatialQueryScratch<number>();
  try {
    expect(index.query(bounds, scratch)).toBe(25);
    expect(observed.counts).toEqual({ columns: 9, cells: 45, slots: 25 });
    expect(observed.comparisons()).toBeGreaterThan(0);
    expect(observed.comparisons()).toBeLessThanOrEqual(79 * observed.comparisonsPerLookupBound);
    observed.reset();
    const cursor = index.beginQuery(bounds);
    const ids: number[] = [];
    let work = 0;
    let done = false;
    while (!done) {
      const step = cursor.advance(64);
      work += step.workUnits;
      expect(work).toBeLessThanOrEqual(131);
      ids.push(...step.ids);
      done = step.done;
    }
    expect(ids).toEqual(Array.from({ length: scratch.count }, (_, offset) => scratch.at(offset)));
    expect(observed.counts).toEqual({ columns: 9, cells: 45, slots: 25 });
    expect(observed.comparisons()).toBeLessThanOrEqual(79 * observed.comparisonsPerLookupBound);
    expect(cursor.memoryUsage()).toBe(0);
  } finally {
    observed.restore();
    scratch.release();
  }
});

async function loadFixture(): Promise<void> {
  const loadedFixture = createStandardRuntimeDomainFixture();
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => Promise.resolve(),
  });
  const appendResult = await builder.appendOwnedRuntime(loadedFixture.elements);
  const loadedStore = await builder.finalize();
  expect(appendResult).toBe("accepted");
  if (loadedStore === null) throw new Error("Runtime fixture store construction was cancelled.");
  store = loadedStore;
  fixture = { ...loadedFixture, elements: [] };
}
describe("normalized store and command costs", () => {
  beforeEach(loadFixture);
  it("commits one-stroke paint changes without scans, retained growth, or unrelated replacement", async () => {
    const changedId = fixture.strokeIds[0] as string;
    const stableId = fixture.strokeIds[9999] as string;
    const stableRecord = store.get(stableId)!;
    const retainedBytes = store.instrumentation.estimatedRetainedBytes;
    store.resetInstrumentation();

    for (const opacity of [0.99, 1, 0.99]) {
      const current = store.get(changedId)!.element;
      if (current.kind !== "stroke") throw new Error("Expected stroke fixture record.");
      const replacement = structuredClone(current) as StrokeElementV1;
      replacement.style.opacity = opacity;
      store.replace(changedId, replacement);
    }

    expect(store.get(stableId)).toBe(stableRecord);
    expect(store.instrumentation.estimatedRetainedBytes).toBe(retainedBytes);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 3,
      recordReplacements: 3,
      reverseDependencyVisits: 0,
      snapshotMaterializations: 0,
    });
  });

  it("uses the reverse map for the normative mixed fixture's 512-endpoint target", () => {
    expect(fixture.strokeCount).toBe(10_000);
    expect(fixture.strokePointCount).toBe(500_000);
    expect(fixture.shapeCount).toBe(500);
    expect(fixture.linearElementCount).toBe(500);
    expect(fixture.lineCount).toBe(250);
    expect(fixture.arrowCount).toBe(250);
    expect(store.size).toBe(11_000);
    expect(store.getMaximumBottom()).toBeGreaterThanOrEqual(200_000);
    expect(new Set(fixture.arrowNodes)).toEqual(
      new Set(["none", "arrow", "triangle", "diamond", "circle"]),
    );
    let dependentEndpoints = 0;
    store.visitDependents(fixture.connectedTargetId, () => {
      dependentEndpoints += 1;
    });
    expect(dependentEndpoints).toBe(512);
    const target = store.get(fixture.connectedTargetId)!.element;
    if (target.kind !== "rectangle") throw new Error("Expected rectangle target.");
    const replacement = structuredClone(target) as InkElementV1;
    if (replacement.kind !== "rectangle") throw new Error("Expected rectangle replacement.");
    replacement.x += 1;
    replacement.pivot.x += 1;
    store.resetInstrumentation();

    const delta = store.replace(replacement.id, replacement);

    expect(delta?.changes).toHaveLength(257);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 512,
      snapshotMaterializations: 0,
    });
  });

  it("reorders an alternating 5,000-element selection without replacing records", () => {
    const selected = new Set(fixture.strokeIds.filter((_, index) => index % 2 === 0));
    const stableRecord = store.get(fixture.strokeIds[1] as string)!;
    store.resetInstrumentation();
    const delta = store.arrange(selected, "bring-to-front");

    expect(delta?.changes.length).toBeGreaterThanOrEqual(10_000);
    expect(store.get(fixture.strokeIds[1] as string)).toBe(stableRecord);
    expect(store.instrumentation).toMatchObject({
      bandScans: 1,
      fullStoreScans: 0,
      recordReplacements: 0,
    });
  });
});

describe("spatial queries, selection, and snapping", () => {
  it("reuses hit-test scratch for early, middle and terminal maximum-stroke hits", async () => {
    await loadFixture();
    const scratch = new SpatialQueryScratch<string>();
    const hitScratch = new HitTestScratch();
    const queryBounds = { maxX: 38, maxY: 38, minX: 22, minY: 22 };
    store.query(queryBounds, scratch);
    const warmAllocations = scratch.allocationCount;
    const maximumPressureStroke: StrokeElementV1 = {
      ...requireStroke(store, fixture.strokeIds[0]!),
      points: Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [
        index * 4,
        0,
        index % 2,
      ]).flat(),
      pivot: { x: 0, y: 0 },
      rotation: 0,
      style: { ...requireStroke(store, fixture.strokeIds[0]!).style, pressureEnabled: true },
    };
    Object.freeze(maximumPressureStroke.points);
    elementContainsPoint(maximumPressureStroke, { x: 8000, y: 0 }, 0);

    for (const x of [0, 8000, (MAX_STROKE_POINTS - 1) * 4]) {
      store.query(queryBounds, scratch);
      findFrontmostHit(hitScratch, { x: 30, y: 30 }, "pen", 1, hitCandidates(store, scratch));
      const containsPoint = elementContainsPoint(maximumPressureStroke, { x, y: 0 }, 0);
      expect(containsPoint).toBe(true);
    }

    expect(scratch.allocationCount).toBe(warmAllocations);
    expect(scratch.candidateVisitCount).toBeLessThan(10);
  });

  it("limits cold and repeated warm snap lookups to spatially returned targets", () => {
    const snapStore = new ElementStore(createDenseSnapTargets());
    const query = new StoreSpatialQuery(snapStore);
    const reader = new StoreTargetReader(snapStore);
    snapStore.resetInstrumentation();

    for (let operation = 0; operation < 3; operation += 1) {
      reader.reset();
      findSnapCandidate(
        { current: null, pointer: { x: 100, y: 500 }, pointerType: "pen", zoom: 1 },
        query,
        reader,
        query.scratch,
      );
      expect(reader.targetReads).toBe(128);
    }

    expect(query.scratch.allocationCount).toBe(query.warmAllocationCount);
    expect(query.storeScratch.allocationCount).toBe(query.warmStoreAllocationCount);
    expect(snapStore.instrumentation).toMatchObject({
      anchorBuilds: 128,
      anchorCacheHits: 128 * 2,
      fullStoreScans: 0,
    });
  });
});

describe("large selection commit", () => {
  beforeEach(loadFixture);
  it("commits 10,000-stroke transforms atomically through reversal and history eviction", async () => {
    store.resetInstrumentation();
    const history = new ActiveEditorHistory(createNoopHistoryModel());
    let partialStoreObserved = false;
    let publishedDeltas = 0;
    const unsubscribe = store.subscribe(() => {
      publishedDeltas += 1;
    });

    const run = await exerciseTransformRun(
      store,
      history,
      fixture.strokeIds,
      3,
      (stableId, stableRecord) => {
        if (store.get(stableId) !== stableRecord) partialStoreObserved = true;
      },
    );
    unsubscribe();
    expect(run.yieldsPerOperation).toHaveLength(3);
    expect(run.yieldsPerOperation.every((count) => count > 0)).toBe(true);
    expect(run.checkpointCounts.every((count) => count <= 40)).toBe(true);
    expect(partialStoreObserved).toBe(false);
    expect(publishedDeltas).toBe(3);
    // Each complete before/after payload is 30,560,000 bytes. The third command
    // crosses 64 MiB and must evict the oldest while retaining the two newest.
    expect(history.commandCount).toBe(2);
    expect(run.maximumRetainedHistoryBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 3,
      recordReplacements: 3 * 10_000,
      snapshotMaterializations: 0,
      timeSlicedIndexVisits: 3 * 10_000,
    });
  }, 180_000);
});

describe("large selection commit cancellation", () => {
  beforeEach(loadFixture);
  it("discards detached replacement work when a concurrent commit wins", async () => {
    const replacementId = fixture.strokeIds[0] as string;
    const competingId = fixture.strokeIds[1] as string;
    const original = requireStroke(store, replacementId);
    const competing = structuredClone(requireStroke(store, competingId));
    competing.style.opacity = competing.style.opacity === 1 ? 0.99 : 1;
    const moved = await moveSelectionTimeSliced(
      [original],
      { x: 0.001, y: 0.001 },
      {
        shouldYield: () => false,
        yieldControl: async () => Promise.resolve(),
      },
    );
    if (moved === null || moved[0]?.kind !== "stroke") {
      throw new Error("Expected one transformed stroke.");
    }
    let yielded = false;
    const prepared = await store.prepareElementReplacement([moved[0]], {
      shouldYield: () => !yielded,
      yieldControl: async () => {
        yielded = true;
        store.replace(competing.id, competing);
      },
    });

    expect(prepared.status).toBe("cancelled");
    expect(prepared.token).toBeNull();
    expect(store.get(replacementId)?.element).toBe(original);
  });
});

function* hitCandidates(storeValue: ElementStore, scratch: SpatialQueryScratch<string>) {
  for (let index = 0; index < scratch.count; index += 1) {
    const id = scratch.at(index);
    const record = storeValue.get(id);
    const rank = storeValue.getRank(id);
    if (record !== undefined && rank !== undefined) {
      yield { band: rank.band, element: record.element as InkElementV1, rank: rank.rank };
    }
  }
}

function findFrontmostHit(
  scratch: HitTestScratch,
  point: Readonly<{ x: number; y: number }>,
  pointerType: "mouse" | "pen" | "touch",
  zoom: number,
  candidates: Iterable<{
    readonly band: "content" | "highlight";
    readonly element: InkElementV1;
    readonly rank: number;
  }>,
): string | null {
  scratch.begin(point, pointerType, zoom);
  for (const candidate of candidates) {
    scratch.consider(candidate.element.id, candidate.band, candidate.element, candidate.rank);
  }
  return scratch.finish();
}

class StoreSpatialQuery implements SpatialCandidateQuery {
  readonly scratch = new SnapCandidateScratch();
  readonly storeScratch = new SpatialQueryScratch<string>();
  readonly warmAllocationCount: number;
  readonly warmStoreAllocationCount: number;

  public constructor(private readonly storeValue: ElementStore) {
    this.query({ maxX: 112, maxY: 512, minX: 88, minY: 488 }, this.scratch);
    this.warmAllocationCount = this.scratch.allocationCount;
    this.warmStoreAllocationCount = this.storeScratch.allocationCount;
  }

  public query(
    bounds: {
      maxX: number;
      maxY: number;
      minX: number;
      minY: number;
    },
    sink: SpatialCandidateSink,
  ): void {
    const count = this.storeValue.query(bounds, this.storeScratch);
    for (let index = 0; index < count; index += 1) sink.add(this.storeScratch.at(index));
  }
}

class StoreTargetReader implements SnapTargetReader {
  public targetReads = 0;

  public constructor(private readonly storeValue: ElementStore) {}

  public get(id: string) {
    this.targetReads += 1;
    const anchors = this.storeValue.getSemanticAnchors(id);
    const rank = this.storeValue.getRank(id);
    return anchors === null || rank === undefined ? null : { anchors, rank: rank.rank };
  }

  public reset(): void {
    this.targetReads = 0;
  }
}
