// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as recognition from "../../../../../src/domain/recognition/stroke-recognition";
import * as geometry from "../../../../../src/domain/geometry/primitives";
import * as arrows from "../../../../../src/domain/recognition/arrow-recognition";
import * as linear from "../../../../../src/domain/recognition/linear-recognition";
import * as corners from "../../../../../src/domain/recognition/closed-contour-corners";
import * as creation from "../../../../../src/domain/geometry/creation";
import type { ArrowNodeV1 } from "../../../../../src/domain/schema/types";
import { MAX_STROKE_POINTS } from "../../../../../src/domain/schema/public";
import type { SpatialQueryCursor } from "../../../../../src/domain/spatial/query-cursor";
import type {
  FrameCancellation,
  WorkPriority,
  WorkScheduler,
} from "../../../../../src/domain/scheduling/work-scheduler";
import { HoldToShapeSession } from "../../../../../src/editor/tools/hold-to-shape-session";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import {
  closedWorkProbe,
  headWorkProbe,
  maximumArrow,
  maximumRectangle,
  maximumSampledPath,
  observedNormalization,
} from "../../../../unit/domain/recognition/recognition-fixtures";
import { edgeArrowPath } from "../../../../unit/domain/recognition/edge-arrow-fixtures";
import { irregularArrowPath } from "../../../../unit/domain/recognition/irregular-arrow-fixtures";
import {
  advanceHold,
  createHoldFixture,
  holdPointer,
} from "../../../../fixtures/obsidian/hold-to-shape";
import { sampledPath } from "../../../../unit/domain/recognition/recognition-fixtures";
import { rectangle } from "../../../../unit/domain/store/fixtures";
import { uuid } from "../../../../unit/domain/schema/fixtures";
import { capturedPentagramPoints } from "../../../../fixtures/domain/captured-pentagrams";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(source: number[], scheduler: WorkScheduler = immediateWorkScheduler()) {
  let reads = 0;
  const copy = vi.spyOn(source, "slice");
  const samples = new Proxy(source, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const readPoints = vi.fn(() => samples);
  const onPreview = vi.fn();
  const session = new HoldToShapeSession({
    settings: { enabled: true, holdDurationMs: 600, jitterTolerancePx: 4 },
    start: { x: 0, y: 0 },
    zoom: 1,
    scheduler,
    readPoints,
    onPreview,
    isCurrent: () => true,
    clock: {
      now: () => Date.now(),
      schedule: (delay, callback) => window.setTimeout(callback, delay),
      cancel: (handle) => window.clearTimeout(handle),
    },
  });
  return { session, readPoints, onPreview, copy, reads: () => reads };
}

function expectBoundedArrowWork(
  source: number[],
  nodes: readonly [ArrowNodeV1, ArrowNodeV1],
): void {
  const { distance, spans, bounds } = headWorkProbe();
  const pointDistance = vi.spyOn(geometry, "pointDistance");
  const fitArrow = vi.spyOn(arrows, "recognizeArrowSteps");
  const fitShaft = vi.spyOn(linear, "recognizeLinear");
  const fixture = setup(source);
  vi.advanceTimersByTime(600);
  expect(fixture.session.candidate).toMatchObject({
    kind: "arrow",
    startNode: nodes[0],
    endNode: nodes[1],
  });
  expect(fitArrow).toHaveBeenCalledTimes(1);
  expect(fitArrow.mock.calls[0]![0].length).toBeLessThanOrEqual(256);
  expect(fitShaft.mock.calls.length).toBeGreaterThan(0);
  expect(fitShaft.mock.calls.length).toBeLessThanOrEqual(49);
  expect(fitShaft.mock.calls.every(([points]) => points.length <= 256)).toBe(true);
  // Projection already measured the source; only newly oriented points may need one further scan.
  expect(
    spans.every((span) => span.sourceBoundsReads === 0 && span.boundsReads <= span.points),
  ).toBe(true);
  // Pentagram rejection may first measure the normalized path once (at most 256 points).
  expect(bounds.mock.calls.length).toBeLessThanOrEqual(
    256 + 2 * spans.reduce((sum, span) => sum + span.points, 0),
  );
  // One original fidelity scan plus at most four full normalized point-pair visits.
  expect(distance.mock.calls.length).toBeGreaterThan(0);
  expect(distance.mock.calls.length).toBeLessThanOrEqual(MAX_STROKE_POINTS + 4 * 256 ** 2);
  // Five source passes; bounded tangent/head scans and templates; at most 49 five-pass shafts.
  expect(pointDistance.mock.calls.length).toBeLessThanOrEqual(
    5 * MAX_STROKE_POINTS + 3 * 256 ** 2 + 5 * 49 * 256,
  );
  fixture.session.dispose();
  expect(vi.getTimerCount()).toBe(0);
}

function indexedHoldFixture(scheduler = immediateWorkScheduler()) {
  const cursors: SpatialQueryCursor<string>[] = [];
  let work = 0;
  let reads = 0;
  let fallbacks = 0;
  const elements = Array.from({ length: 10_000 }, (_, index) =>
    rectangle(
      uuid(1000 + index),
      20_000 + (index % 100) * 512,
      10_000 + Math.floor(index / 100) * 512,
    ),
  );
  elements.push(rectangle(uuid(20_000), 100, 100), rectangle(uuid(20_001), 1000, 100));
  const fixture = createHoldFixture({
    points: sampledPath(
      [
        [102, 102],
        [1002, 102],
      ],
      false,
    ),
    elements,
    workScheduler: scheduler,
    snap: (scene) => ({
      connections: true,
      angles: false,
      zoom: 1,
      pageToScreen: (point) => point,
      spatial: {
        readRevision: () => scene.readRevision(),
        beginQuery: (bounds) => {
          const cursor = scene.beginQuery(bounds);
          cursors.push(cursor);
          const advance = cursor.advance.bind(cursor);
          vi.spyOn(cursor, "advance").mockImplementation((units) => {
            const result = advance(units);
            work += result.workUnits;
            return result;
          });
          return cursor;
        },
        query: (bounds, sink) => {
          fallbacks++;
          scene.query(bounds, sink);
        },
      },
      targets: {
        get: (id, bounds) => {
          reads++;
          return scene.getSnapTarget(id, bounds);
        },
      },
    }),
  });
  return { fixture, cursors, counts: () => ({ queries: cursors.length, work, reads, fallbacks }) };
}

function suspendedWork(priority?: WorkPriority) {
  const active = new Set<FrameCancellation>();
  let maximumPending = 0;
  const scheduler: WorkScheduler = {
    ...immediateWorkScheduler(),
    shouldYield: () => true,
    checkpoint: (signal, requestedPriority) => {
      if (priority !== undefined && requestedPriority !== priority) return undefined;
      if (signal === undefined) throw new Error("Suspended work must own cancellation.");
      active.add(signal);
      maximumPending = Math.max(maximumPending, active.size);
      return new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            active.delete(signal);
            resolve();
          },
          { once: true },
        ),
      );
    },
  };
  return { scheduler, active, maximumPending: () => maximumPending };
}

describe("hold-to-shape endpoint fitting work", () => {
  it("bounds coarse pentagram fallback and native fitting at maximum capacity", () => {
    const distance = vi.spyOn(geometry, "pointSegmentDistance");
    const simplify = vi.spyOn(corners, "closedContourCorners");
    const native = vi.spyOn(creation, "shapeVertices");
    const fixture = setup(maximumSampledPath(capturedPentagramPoints(79)));
    vi.advanceTimersByTime(600);
    expect(fixture.session.candidate?.kind).toBe("star");
    expect(fixture.reads()).toBe(MAX_STROKE_POINTS * 3);
    expect(simplify).toHaveBeenCalledTimes(2);
    expect(native).toHaveBeenCalledTimes(5);
    // One raw fidelity scan, two bounded RDP searches, and one assigned-edge fidelity pass.
    expect(distance.mock.calls.length).toBeGreaterThan(0);
    expect(distance.mock.calls.length).toBeLessThanOrEqual(MAX_STROKE_POINTS + 21 * 256 + 18);
    fixture.session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds real segment-distance work for two detailed heads on a maximum-capacity stroke", () => {
    expectBoundedArrowWork(maximumArrow(), ["circle", "circle"]);
  });

  it.each([
    ["circle", "circle", false],
    ["triangle", "diamond", true],
  ] as const)("bounds actual work for edge-attached %s/%s heads", (start, end, curved) => {
    expectBoundedArrowWork(maximumSampledPath(edgeArrowPath(start, end, curved)), [start, end]);
  });
});

describe("hold-to-shape original-path fidelity work", () => {
  it("checks exactly one segment per original sample with three linear coordinate scans", () => {
    const source = maximumRectangle();
    const distance = vi.spyOn(geometry, "pointSegmentDistance");
    const { steps, work } = observedNormalization(source);
    let step = steps.next();
    while (!step.done) step = steps.next();
    expect(step.value?.points.length).toBeLessThanOrEqual(256);
    expect(distance).toHaveBeenCalledTimes(MAX_STROKE_POINTS);
    expect(work.indexedReads).toBeLessThanOrEqual(source.length * 2);
  });
});

describe("irregular arrow template work", () => {
  it.each(["arrow", "diamond"] as const)(
    "bounds actual native and uneven %s fits on a maximum-capacity curve",
    (node) => {
      const { distance, spans } = headWorkProbe();
      const shaft = vi.spyOn(linear, "recognizeLinear");
      const fixture = setup(maximumSampledPath(irregularArrowPath(node, node, true)));
      vi.advanceTimersByTime(600);
      expect(fixture.session.candidate).toMatchObject({
        kind: "arrow",
        startNode: node,
        endNode: node,
      });
      expect(fixture.copy).toHaveBeenCalledTimes(1);
      expect(fixture.reads()).toBe(MAX_STROKE_POINTS * 3);
      expect(spans.length).toBeGreaterThan(0);
      expect(
        spans.some((span) => (node === "arrow" ? span.openUneven : span.closedUneven) > 0),
      ).toBe(true);
      expect(spans.length).toBeLessThanOrEqual(2 * (256 - 4) * 4);
      // Each cut has four tangent windows; one attachment has four native and three uneven templates.
      // Existing tip fits and at most five translated closed-marker templates share each contour.
      expect(spans.every((span) => span.points <= 256 && span.matchedSteps <= 12)).toBe(true);
      // The largest template is a 32-segment circle: bidirectional midpoint scans cost <129m.
      expect(spans.every((span) => span.maxStep <= 129 * span.points + 1)).toBe(true);
      const headCalls = spans.reduce((sum, span) => sum + span.calls, 0);
      expect(distance.mock.calls.length - headCalls).toBeLessThanOrEqual(
        MAX_STROKE_POINTS + 18 * 256 + 49 * 257,
      );
      expect(shaft.mock.calls.length).toBeLessThanOrEqual(49);
      fixture.session.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels before an uneven open-head fit without continuing template scans or retaining a job", async () => {
    let pause = false;
    const { distance } = headWorkProbe((points, boundary) => {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const depth = -Math.min(...points.map((point) => point.x));
      if (
        boundary === 2 &&
        Math.hypot(first.x - last.x, first.y - last.y) > Math.max(1.5, depth * 0.14)
      )
        pause = true;
    });
    const blocked = suspendedWork();
    const scheduler: WorkScheduler = {
      ...immediateWorkScheduler(),
      checkpoint: (signal, priority) =>
        pause ? blocked.scheduler.checkpoint(signal, priority) : undefined,
    };
    const fixture = setup(
      maximumSampledPath(irregularArrowPath("arrow", "arrow", true)),
      scheduler,
    );
    vi.advanceTimersByTime(600);
    expect(pause).toBe(true);
    expect(blocked.active.size).toBe(1);
    const scanned = distance.mock.calls.length;
    expect(scanned).toBeGreaterThan(MAX_STROKE_POINTS);
    fixture.session.observe([{ x: 20, y: 0 }]);
    fixture.session.dispose();
    await Promise.resolve();
    expect(blocked.active.size).toBe(0);
    expect(blocked.maximumPending()).toBe(1);
    expect(distance).toHaveBeenCalledTimes(scanned);
    expect(fixture.onPreview).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("hold-to-shape bounded work and ownership", () => {
  it("copies at most 16,384 samples once per quiet interval and bounds real closed-shape candidates", () => {
    const { fit, prepare, rotate, pivot } = closedWorkProbe();
    const recognize = vi.spyOn(recognition, "recognizeStrokeSteps");
    const fixture = setup(maximumRectangle());
    const { session, readPoints, copy } = fixture;
    for (let index = 0; index < MAX_STROKE_POINTS; index++)
      session.observe([{ x: index * 5, y: 0 }]);
    expect(readPoints).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(100);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(fixture.reads()).toBe(MAX_STROKE_POINTS * 3);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize.mock.calls[0]?.[0]).toHaveLength(MAX_STROKE_POINTS * 3);
    // Seven shapes, 120 coarse angles, nine local angles each and four native contour refinements.
    expect(fit.mock.calls.length).toBeGreaterThan(0);
    expect(fit.mock.calls.length).toBeLessThanOrEqual(7 * (120 + 9) + 4);
    expect(fit.mock.calls.every(([path]) => path.local.length <= 256)).toBe(true);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(120 + 7 * 9 + 4);
    expect(prepare.mock.calls.every(([points]) => points.length <= 256)).toBe(true);
    expect(new Set(fit.mock.calls.map(([, kind]) => kind)).size).toBe(7);
    expect(fit.mock.calls.slice(0, 7).every(([path]) => path === fit.mock.calls[0]![0])).toBe(true);
    // One shared rotation/pivot per angle; a side-refitted rectangle may move its pivot once.
    expect(rotate).toHaveBeenCalledTimes(prepare.mock.calls.length);
    const rectangles = fit.mock.calls.filter(([, kind]) => kind === "rectangle").length;
    expect(pivot.mock.calls.length).toBeGreaterThanOrEqual(prepare.mock.calls.length);
    expect(pivot.mock.calls.length).toBeLessThanOrEqual(prepare.mock.calls.length + rectangles + 4);
    vi.advanceTimersByTime(500);
    expect(session.candidate?.kind).toBe("rectangle");
    const fits = fit.mock.calls.length;
    const preparations = prepare.mock.calls.length;
    const rotations = rotate.mock.calls.length;
    const pivots = pivot.mock.calls.length;
    session.observe(
      Array.from({ length: MAX_STROKE_POINTS }, () => ({
        x: (MAX_STROKE_POINTS - 1) * 5 + 1,
        y: 1,
      })),
    );
    vi.advanceTimersByTime(60_000);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(fits);
    expect(prepare).toHaveBeenCalledTimes(preparations);
    expect(rotate).toHaveBeenCalledTimes(rotations);
    expect(pivot).toHaveBeenCalledTimes(pivots);
    expect(vi.getTimerCount()).toBe(0);
    session.observe([{ x: 0, y: 0 }]);
    expect(session.candidate).toBeNull();
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(600);
    expect(copy).toHaveBeenCalledTimes(2);
    expect(fixture.reads()).toBe(MAX_STROKE_POINTS * 6);
    expect(fit).toHaveBeenCalledTimes(fits * 2);
    expect(prepare).toHaveBeenCalledTimes(preparations * 2);
    expect(rotate).toHaveBeenCalledTimes(rotations * 2);
    expect(pivot).toHaveBeenCalledTimes(pivots * 2);
    session.dispose();
    expect(session.candidate).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects over-capacity samples before copying or fitting", () => {
    const recognize = vi.spyOn(recognition, "recognizeStrokeSteps");
    const fixture = setup(maximumRectangle(MAX_STROKE_POINTS + 1));
    vi.advanceTimersByTime(600);
    expect(fixture.copy).not.toHaveBeenCalled();
    expect(fixture.reads()).toBe(0);
    expect(recognize).not.toHaveBeenCalled();
    expect(fixture.session.candidate).toBeNull();
    fixture.session.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts each suspended recognition before restart without retaining jobs or reading stale samples", async () => {
    const { scheduler, active, maximumPending } = suspendedWork();
    const fixture = setup(maximumRectangle(), scheduler);
    for (const x of [10, 20, 30]) {
      vi.advanceTimersByTime(100);
      expect(active.size).toBe(1);
      fixture.session.observe([{ x, y: 0 }]);
      await Promise.resolve();
      expect(active.size).toBe(0);
      expect(vi.getTimerCount()).toBe(2);
    }
    vi.advanceTimersByTime(600);
    expect(active.size).toBe(1);
    fixture.session.dispose();
    await Promise.resolve();
    expect(maximumPending()).toBe(1);
    expect(active.size).toBe(0);
    expect(fixture.readPoints).not.toHaveBeenCalled();
    expect(fixture.reads()).toBe(0);
    expect(fixture.copy).not.toHaveBeenCalled();
    expect(fixture.onPreview).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("recognized endpoint indexed work", () => {
  it("queries only Down, accepted endpoints and revisions across 10,000 unrelated shapes", () => {
    const { fixture, cursors, counts } = indexedHoldFixture();
    try {
      expect(counts().queries).toBe(1);
      const down = counts();
      const jitter = Array.from({ length: 512 }, (_, index) => ({
        ...holdPointer(1002 + (index % 2) * 0.5, 102),
        time: 10_000 + index,
      }));
      fixture.preview.observeInputSamples(jitter);
      fixture.preview.updateSamples(jitter);
      expect(counts()).toEqual(down);
      advanceHold(fixture);
      expect(counts().queries).toBe(2);
      const held = counts();
      fixture.preview.observeInputSamples(jitter);
      fixture.preview.updateSamples(jitter);
      expect(counts()).toEqual(held);
      fixture.store.create([rectangle(uuid(30_000), 90_000, 90_000)]);
      fixture.preview.updateSamples([{ ...holdPointer(1002, 102), time: 20_000 }]);
      const beforeRelease = counts();
      expect(fixture.preview.commit()).toBe(true);
      expect(counts()).toEqual(beforeRelease);
      // At most two endpoints on adoption and revision, plus the initial Down query.
      expect(counts().queries).toBeLessThanOrEqual(5);
      expect(counts().reads).toBeLessThanOrEqual(5);
      // Each narrow query intersects one local candidate and at most twelve cursor work units.
      expect(counts().work).toBeGreaterThan(0);
      expect(counts().work).toBeLessThanOrEqual(counts().queries * 12);
      expect(counts().fallbacks).toBe(0);
      expect(fixture.store.instrumentation.fullStoreScans).toBe(0);
      expect(cursors.every((cursor) => cursor.memoryUsage() === 0)).toBe(true);
    } finally {
      fixture.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels both accepted endpoint cursors and queued continuations when raw movement resumes", async () => {
    const { scheduler, active, maximumPending } = suspendedWork("input");
    const { fixture, cursors, counts } = indexedHoldFixture(scheduler);
    try {
      advanceHold(fixture);
      expect(active.size).toBeGreaterThan(0);
      expect(active.size).toBeLessThanOrEqual(2);
      expect(counts().work).toBe(0);
      fixture.preview.observeInputSamples([holdPointer(1100, 102)]);
      await Promise.resolve();
      expect(active.size).toBe(0);
      expect(cursors.every((cursor) => cursor.memoryUsage() === 0)).toBe(true);
      expect(maximumPending()).toBeLessThanOrEqual(2);
      expect(counts().fallbacks).toBe(0);
      expect(fixture.store.instrumentation.fullStoreScans).toBe(0);
    } finally {
      fixture.dispose();
    }
    await Promise.resolve();
    expect(active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shared closed preparation cancellation", () => {
  it("stops after one kind without repeating point rotations or retaining a continuation", async () => {
    const { fit, prepare, rotate, pivot } = closedWorkProbe();
    const blocked = suspendedWork();
    const scheduler: WorkScheduler = {
      ...immediateWorkScheduler(),
      checkpoint: (signal, priority) =>
        fit.mock.calls.length > 0 ? blocked.scheduler.checkpoint(signal, priority) : undefined,
    };
    const fixture = setup(maximumRectangle(), scheduler);
    vi.advanceTimersByTime(600);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1);
    fixture.session.dispose();
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(pivot).toHaveBeenCalledTimes(1);
    expect(blocked.active.size).toBe(0);
    expect(blocked.maximumPending()).toBe(1);
    expect(fixture.onPreview).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
