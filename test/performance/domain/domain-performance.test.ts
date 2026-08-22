import { beforeAll, describe, expect, it } from "vitest";

import { StrokeCaptureBuffer } from "../../../src/domain/elements/public";
import type { InkElementV1, StrokeElementV1 } from "../../../src/domain/schema/public";
import { SpatialQueryScratch } from "../../../src/domain/spatial/index";
import { ElementStore } from "../../../src/domain/store/public";
import { findFrontmostHit } from "../../../src/editor/selection/hit-test";
import { selectByLasso } from "../../../src/editor/selection/selection-model";
import { moveSelectionTimeSliced } from "../../../src/editor/selection/transforms";
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
  MeasuredSliceScheduler,
  measureMaximumStrokeRun,
  measureTransformRun,
  percentile,
  requireStroke,
  type Distribution,
  type TransformRun,
  worstDistribution,
} from "./domain-scenarios";
import { collectProfileGarbage } from "../persistence/metrics";

let fixture: StandardDomainFixture;
let store: ElementStore;
let storeConstructionDuration = 0;

beforeAll(async () => {
  const loadedFixture = createStandardRuntimeDomainFixture();
  const builder = ElementStore.createBuilder({
    shouldYield: () => false,
    yieldControl: async () => Promise.resolve(),
  });
  const started = performance.now();
  expect(await builder.appendOwnedRuntime(loadedFixture.elements)).toBe("accepted");
  const loadedStore = await builder.finalize();
  storeConstructionDuration = performance.now() - started;
  if (loadedStore === null) throw new Error("Runtime fixture store construction was cancelled.");
  store = loadedStore;
  fixture = { ...loadedFixture, elements: [] };
});

describe("standard 10,000-stroke domain fixture", () => {
  it("matches the normative point, shape, connection, overflow, and extent boundaries", () => {
    expect(fixture.strokeCount).toBe(10_000);
    expect(fixture.strokePointCount).toBe(500_000);
    expect(fixture.shapeCount).toBe(500);
    expect(fixture.linearElementCount).toBe(500);
    expect(fixture.lineCount).toBe(250);
    expect(fixture.arrowCount).toBe(250);
    expect(store.size).toBe(11_000);
    expect(store.getMaximumBottom()).toBeGreaterThanOrEqual(200_000);
    expect(storeConstructionDuration).toBeLessThanOrEqual(750);

    let dependentEndpoints = 0;
    store.visitDependents(fixture.connectedTargetId, () => {
      dependentEndpoints += 1;
    });
    expect(dependentEndpoints).toBe(512);

    expect(new Set(fixture.arrowNodes)).toEqual(
      new Set(["none", "arrow", "triangle", "diamond", "circle"]),
    );
  });

  it("builds a complete initial store in cancellable bounded slices", async () => {
    const hydrationFixture = createStandardRuntimeDomainFixture();
    const scheduler = new MeasuredSliceScheduler(8);
    const builder = ElementStore.createBuilder(scheduler);
    const started = performance.now();
    expect(await builder.appendOwnedRuntime(hydrationFixture.elements)).toBe("accepted");
    const hydrated = await builder.finalize();
    const duration = performance.now() - started;
    scheduler.finish();

    expect(hydrated?.size).toBe(11_000);
    expect(hydrated?.instrumentation).toMatchObject({
      hydrationElementVisits: 22_000,
      publishedDeltas: 0,
    });
    expect(duration).toBeLessThanOrEqual(750);
    expect(scheduler.maxSliceDuration).toBeLessThanOrEqual(16.7);
  });
});

describe("normalized store and command costs", () => {
  it("commits one-stroke paint changes without scans, retained growth, or unrelated replacement", async ({
    annotate,
  }) => {
    const changedId = fixture.strokeIds[0] as string;
    const stableId = fixture.strokeIds[9999] as string;
    const stableRecord = store.get(stableId)!;
    const retainedBytes = store.instrumentation.estimatedRetainedBytes;
    const durations: number[] = [];
    store.resetInstrumentation();

    for (let operation = 0; operation < 500; operation += 1) {
      const current = store.get(changedId)!.element;
      if (current.kind !== "stroke") throw new Error("Expected stroke fixture record.");
      const replacement = structuredClone(current) as StrokeElementV1;
      replacement.style.opacity = operation % 2 === 0 ? 0.99 : 1;
      const started = performance.now();
      store.replace(changedId, replacement);
      durations.push(performance.now() - started);
    }

    const p95 = percentile(durations, 0.95);
    expect(p95).toBeLessThanOrEqual(12);
    expect(store.get(stableId)).toBe(stableRecord);
    expect(store.instrumentation.estimatedRetainedBytes).toBe(retainedBytes);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 500,
      recordReplacements: 500,
      reverseDependencyVisits: 0,
      snapshotMaterializations: 0,
    });
    await annotate(
      `500 one-stroke steady-state commits: retainedGrowth=0 bytes, p95=${p95.toFixed(3)} ms`,
      "performance",
    );
  });

  it("uses the reverse map for a 512-endpoint target commit", () => {
    const target = store.get(fixture.connectedTargetId)!.element;
    if (target.kind !== "rectangle") throw new Error("Expected rectangle target.");
    const replacement = structuredClone(target) as InkElementV1;
    if (replacement.kind !== "rectangle") throw new Error("Expected rectangle replacement.");
    replacement.x += 1;
    replacement.pivot.x += 1;
    store.resetInstrumentation();
    collectProfileGarbage();

    const started = performance.now();
    const delta = store.replace(replacement.id, replacement);
    const duration = performance.now() - started;

    expect(delta?.changes).toHaveLength(257);
    expect(duration).toBeLessThanOrEqual(12);
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
    collectProfileGarbage();
    const started = performance.now();
    const delta = store.arrange(selected, "bring-to-front");
    const duration = performance.now() - started;

    expect(delta?.changes.length).toBeGreaterThanOrEqual(10_000);
    expect(duration).toBeLessThanOrEqual(12);
    expect(store.get(fixture.strokeIds[1] as string)).toBe(stableRecord);
    expect(store.instrumentation).toMatchObject({
      bandScans: 2,
      fullStoreScans: 0,
      recordReplacements: 0,
    });
  });
});

describe("spatial queries, selection, and snapping", () => {
  it("reuses scratch allocations for 500 hit-test queries", () => {
    const scratch = new SpatialQueryScratch<string>();
    const queryBounds = { maxX: 38, maxY: 38, minX: 22, minY: 22 };
    store.query(queryBounds, scratch);
    const warmAllocations = scratch.allocationCount;
    const durations: number[] = [];

    for (let operation = 0; operation < 500; operation += 1) {
      const started = performance.now();
      store.query(queryBounds, scratch);
      findFrontmostHit({ x: 30, y: 30 }, "pen", 1, hitCandidates(store, scratch));
      durations.push(performance.now() - started);
    }

    const p95 = percentile(durations, 0.95);
    expect(p95).toBeLessThanOrEqual(8);
    expect(scratch.allocationCount).toBe(warmAllocations);
    expect(scratch.candidateVisitCount).toBeLessThan(10);
  });

  it("selects the complete indexed fixture once without copying element records", () => {
    const scratch = new SpatialQueryScratch<string>();
    const lasso = { maxX: 2048.6, maxY: 210_000, minX: 0, minY: 0 };
    store.query(lasso, scratch);
    const stableRecord = store.get(fixture.strokeIds[0] as string)!;
    const started = performance.now();
    const selection = selectByLasso(new Set(), lasso, lassoCandidates(store, scratch), false);
    const duration = performance.now() - started;

    expect(selection.size).toBe(11_000);
    expect(duration).toBeLessThanOrEqual(12);
    expect(store.get(fixture.strokeIds[0] as string)).toBe(stableRecord);
  });

  it("limits 500 snap lookups to spatially returned targets", () => {
    const snapStore = new ElementStore(createDenseSnapTargets());
    const query = new StoreSpatialQuery(snapStore);
    const reader = new StoreTargetReader(snapStore);
    const durations: number[] = [];
    snapStore.resetInstrumentation();

    for (let operation = 0; operation < 500; operation += 1) {
      reader.reset();
      const started = performance.now();
      findSnapCandidate(
        { current: null, pointer: { x: 100, y: 500 }, pointerType: "pen", zoom: 1 },
        query,
        reader,
        query.scratch,
      );
      durations.push(performance.now() - started);
      expect(reader.targetReads).toBe(128);
    }

    const p95 = percentile(durations, 0.95);
    expect(p95).toBeLessThanOrEqual(8);
    expect(query.scratch.allocationCount).toBe(query.warmAllocationCount);
    expect(query.storeScratch.allocationCount).toBe(query.warmStoreAllocationCount);
    expect(snapStore.instrumentation).toMatchObject({
      anchorBuilds: 128,
      anchorCacheHits: 128 * 499,
      fullStoreScans: 0,
    });
  });
});

describe("large selection commit", () => {
  it("time-slices and atomically commits 50 canonical 10,000-stroke transforms per run", async ({
    annotate,
  }) => {
    store.resetInstrumentation();
    const history = new ActiveEditorHistory(createNoopHistoryModel());
    await measureTransformRun(store, history, fixture.strokeIds, 50);
    const measuredRuns: TransformRun[] = [];
    let partialStoreObserved = false;
    let publishedDeltas = 0;
    const unsubscribe = store.subscribe(() => {
      publishedDeltas += 1;
    });

    for (let run = 0; run < 5; run += 1) {
      measuredRuns.push(
        await measureTransformRun(
          store,
          history,
          fixture.strokeIds,
          50,
          (stableId, stableRecord) => {
            if (store.get(stableId) !== stableRecord) partialStoreObserved = true;
          },
        ),
      );
    }
    unsubscribe();

    const releaseMaterialization = worstDistribution(
      measuredRuns.map(({ materialization }) => materialization),
    );
    const releaseCommit = worstDistribution(measuredRuns.map(({ commit }) => commit));
    const releaseAtomicCommit = worstDistribution(
      measuredRuns.map(({ atomicCommit }) => atomicCommit),
    );
    const releaseHistoryRegistration = worstDistribution(
      measuredRuns.map(({ historyRegistration }) => historyRegistration),
    );
    const maximumSlice = Math.max(...measuredRuns.map(({ maximumSlice }) => maximumSlice));
    const maximumHeapGrowthBytes = Math.max(
      ...measuredRuns.map(({ maximumHeapGrowthBytes }) => maximumHeapGrowthBytes),
    );
    const maximumRetainedHistoryBytes = Math.max(
      ...measuredRuns.map(({ maximumRetainedHistoryBytes }) => maximumRetainedHistoryBytes),
    );

    await annotate(
      transformMetricsAnnotation(
        {
          atomicCommit: releaseAtomicCommit,
          commit: releaseCommit,
          historyRegistration: releaseHistoryRegistration,
          materialization: releaseMaterialization,
        },
        maximumSlice,
        maximumHeapGrowthBytes,
        maximumRetainedHistoryBytes,
      ),
      "performance",
    );

    expect(measuredRuns).toHaveLength(5);
    for (const run of measuredRuns) {
      expect(run.materialization.sampleCount).toBe(50);
      expect(run.commit.sampleCount).toBe(50);
    }
    expect(releaseMaterialization.p95).toBeLessThanOrEqual(100);
    expect(releaseCommit.p95).toBeLessThanOrEqual(100);
    expect(maximumSlice).toBeLessThanOrEqual(16.7);
    expect(partialStoreObserved).toBe(false);
    expect(publishedDeltas).toBe(250);
    expect(history.commandCount).toBeGreaterThan(0);
    expect(maximumRetainedHistoryBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(maximumHeapGrowthBytes).toBeLessThanOrEqual(200 * 1024 * 1024);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      publishedDeltas: 300,
      recordReplacements: 3_000_000,
      snapshotMaterializations: 0,
      timeSlicedIndexVisits: 3_000_000,
    });
  }, 180_000);
});

describe("large selection commit cancellation", () => {
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

describe("maximum live-stroke primitives", () => {
  it("grows the 4,096-sample capture buffer geometrically and publishes once", () => {
    store.resetInstrumentation();
    const capture = new StrokeCaptureBuffer(16);
    for (let point = 0; point < 4096; point += 1) {
      capture.append(point * 0.001, point * 0.001, 0.5);
    }
    const started = performance.now();
    const published = capture.publish();
    const publishDuration = performance.now() - started;

    expect(published).toHaveLength(4096 * 3);
    expect(publishDuration).toBeLessThanOrEqual(8);
    expect(capture.instrumentation).toEqual({
      appendedSamples: 4096,
      bufferGrowths: 8,
      copiedValues: 12_240,
      publishedSamples: 4096,
    });
  });

  it("updates and hands off twenty maximum pressure strokes per measured run", () => {
    measureMaximumStrokeRun(20);
    const measuredRuns = Array.from({ length: 5 }, () => measureMaximumStrokeRun(20));
    const releaseAppend = worstDistribution(measuredRuns.map(({ append }) => append));
    const releaseHandoff = worstDistribution(measuredRuns.map(({ handoff }) => handoff));

    expect(releaseAppend.sampleCount).toBe(20 * 4096);
    expect(releaseAppend.p95).toBeLessThanOrEqual(8);
    expect(releaseHandoff.sampleCount).toBe(20);
    expect(releaseHandoff.p95).toBeLessThanOrEqual(16.7);
    expect(measuredRuns.every(({ maximumTailSamples }) => maximumTailSamples <= 16)).toBe(true);
    expect(
      measuredRuns.every(({ maximumFinalizedChunkSamples }) =>
        Boolean(maximumFinalizedChunkSamples <= 256),
      ),
    ).toBe(true);
  }, 120_000);
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

function* lassoCandidates(storeValue: ElementStore, scratch: SpatialQueryScratch<string>) {
  for (let index = 0; index < scratch.count; index += 1) {
    const id = scratch.at(index);
    const record = storeValue.get(id);
    if (record !== undefined) yield [id, record.bounds] as const;
  }
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

function transformMetricsAnnotation(
  distributions: Readonly<{
    atomicCommit: Distribution;
    commit: Distribution;
    historyRegistration: Distribution;
    materialization: Distribution;
  }>,
  maximumSlice: number,
  maximumHeapGrowthBytes: number,
  maximumRetainedHistoryBytes: number,
): string {
  const { atomicCommit, commit, historyRegistration, materialization } = distributions;
  return (
    `10k transform: materialization p50=${materialization.p50.toFixed(3)} ms, ` +
    `p95=${materialization.p95.toFixed(3)} ms, p99=${materialization.p99.toFixed(3)} ms, ` +
    `max=${materialization.maximum.toFixed(3)} ms; commit p50=${commit.p50.toFixed(3)} ms, ` +
    `p95=${commit.p95.toFixed(3)} ms, p99=${commit.p99.toFixed(3)} ms, ` +
    `max=${commit.maximum.toFixed(3)} ms; atomicCommit p95=${atomicCommit.p95.toFixed(3)} ms, ` +
    `max=${atomicCommit.maximum.toFixed(3)} ms; history p95=${historyRegistration.p95.toFixed(3)} ms, ` +
    `max=${historyRegistration.maximum.toFixed(3)} ms; maxSlice=${maximumSlice.toFixed(3)} ms, ` +
    `maxHeapGrowth=${(maximumHeapGrowthBytes / 1024 / 1024).toFixed(1)} MiB, ` +
    `maxHistory=${(maximumRetainedHistoryBytes / 1024 / 1024).toFixed(1)} MiB, oldSpaceLimit=384 MiB`
  );
}
