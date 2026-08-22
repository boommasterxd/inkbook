import { describe, expect, it } from "vitest";

import type { PageV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { SvgSceneRenderer, type SceneElementRecord } from "../../../../src/rendering/scene";
import {
  MOUNT_SLICE_GEOMETRY_COST_BUDGET,
  MOUNT_SLICE_STROKE_POINT_BUDGET,
} from "../../../../src/rendering/scene/constants";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";

const STROKES = 489;
const MAXIMUM_POINTS = 4_096;
const FINAL_STROKE_POINTS = 1_152;
const TOTAL_POINTS = 2_000_000;
const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 100,
};

describe("visible render mount complexity", () => {
  it("resumes 489 visible strokes with exactly two million points in stable band order", async ({
    annotate,
  }) => {
    const document = new FakeDocument();
    const scheduler = new FakeScheduler();
    const store = new FakeSceneStore();
    const fixture = createMaximumPointFixture();
    for (const record of fixture.records) store.records.set(record.id, record);
    const renderer = new SvgSceneRenderer({
      container: asElement(new FakeNode(document, "div")),
      layout: { readViewport: () => ({ height: 200, left: 0, top: 0, width: 200 }) },
      page: PAGE,
      scheduler,
      store,
    });
    const sliceDurations: number[] = [];

    runMeasuredFrame(scheduler, sliceDurations);
    const firstFrameMounts = renderer.mountedCount;
    while (scheduler.pendingCount > 0) runMeasuredFrame(scheduler, sliceDurations);

    const instrumentation = renderer.instrumentation();
    const cameraGroup = fakeNode(renderer.svg).nodes[1]!;
    expect(fixture.pointCount).toBe(TOTAL_POINTS);
    expect(firstFrameMounts).toBe(0);
    expect(renderer.mountedCount).toBe(STROKES);
    expect(renderer.mountedIds("highlight")).toEqual(fixture.highlightIds);
    expect(renderer.mountedIds("content")).toEqual(fixture.contentIds);
    expect(cameraGroup.nodes[2]?.nodes).toHaveLength(fixture.highlightIds.length);
    expect(cameraGroup.nodes[3]?.nodes).toHaveLength(fixture.contentIds.length);
    expect(instrumentation).toMatchObject({
      domEntrants: STROKES,
      domFragmentRuns: 2,
      geometryBuilds: STROKES,
      maximumMountSliceStrokePoints: MOUNT_SLICE_STROKE_POINT_BUDGET,
      spatialQueries: 1,
    });
    expect(instrumentation.mountSlices).toBeGreaterThan(1);
    expect(instrumentation.mountBudgetYields).toBe(instrumentation.mountSlices - 1);
    expect(instrumentation.maximumMountSliceStrokePoints).toBeLessThanOrEqual(
      MOUNT_SLICE_STROKE_POINT_BUDGET,
    );
    expect(instrumentation.maximumMountSliceGeometryCost).toBeLessThanOrEqual(
      MOUNT_SLICE_GEOMETRY_COST_BUDGET,
    );
    await annotate(
      `render mount slices=${String(instrumentation.mountSlices)}, ` +
        `firstFrameMounts=${String(firstFrameMounts)}, ` +
        `maximumDuration=${Math.max(...sliceDurations).toFixed(3)} ms`,
      "performance",
    );
  });
});

function runMeasuredFrame(scheduler: FakeScheduler, durations: number[]): void {
  const startedAt = performance.now();
  scheduler.runNext();
  durations.push(performance.now() - startedAt);
}

function createMaximumPointFixture(): {
  readonly contentIds: readonly string[];
  readonly highlightIds: readonly string[];
  readonly pointCount: number;
  readonly records: readonly SceneElementRecord[];
} {
  const maximumPoints = strokePoints(MAXIMUM_POINTS);
  const finalPoints = strokePoints(FINAL_STROKE_POINTS);
  const records: SceneElementRecord[] = [];
  const contentIds: string[] = [];
  const highlightIds: string[] = [];
  let pointCount = 0;
  for (let rank = 0; rank < STROKES; rank += 1) {
    const points = rank === STROKES - 1 ? finalPoints : maximumPoints;
    const record = strokeRecord(rank, points);
    records.push(record);
    pointCount += points.length / 3;
    (record.band === "highlight" ? highlightIds : contentIds).push(record.id);
  }
  return { contentIds, highlightIds, pointCount, records };
}

function strokeRecord(rank: number, points: number[]): SceneElementRecord {
  const highlight = rank % 2 === 1;
  const id = `00000000-0000-4000-8000-${String(rank + 1).padStart(12, "0")}`;
  const element: StrokeElementV1 = {
    createdAt: rank,
    id,
    kind: "stroke",
    pivot: { x: 50, y: 50 },
    points,
    rotation: 0,
    style: {
      color: { type: "theme-text" },
      opacity: highlight ? 0.4 : 1,
      pressureEnabled: !highlight,
      smoothing: 0.5,
      width: highlight ? 14 : 2,
    },
    tool: highlight ? "highlighter" : "pen",
  };
  return {
    band: highlight ? "highlight" : "content",
    bounds: { maxX: 101, maxY: 101, minX: 0, minY: 0 },
    element,
    geometryVersion: 1,
    id,
    paintVersion: 1,
    rank,
  };
}

function strokePoints(count: number): number[] {
  const points = new Array<number>(count * 3);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    points[offset] = index % 100;
    points[offset + 1] = (index * 7) % 100;
    points[offset + 2] = 0.5;
  }
  return points;
}
