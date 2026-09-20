import { describe, expect, it } from "vitest";
import { createSceneFixture } from "../../../fixtures/rendering/scene";

import type { PageV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { type SceneElementRecord } from "../../../../src/rendering/scene/types";
import {
  MOUNT_SLICE_GEOMETRY_COST_BUDGET,
  MOUNT_SLICE_STROKE_POINT_BUDGET,
} from "../../../../src/rendering/scene/constants";
import {
  type FakeNode,
  FakeSceneStore,
  type FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
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
};

describe("visible render mount complexity", () => {
  it("resumes 489 visible strokes with exactly two million points in stable band order", async ({
    annotate,
  }) => {
    const fixture = createMaximumPointFixture();
    const { renderer, scheduler } = createMountScene(fixture.records);
    scheduler.runNext();
    const firstFrameMounts = renderer.mountedCount;
    while (scheduler.pendingCount > 0) scheduler.runNext();

    const instrumentation = renderer.instrumentation();
    const cameraGroup = fakeNode(renderer.svg).nodes[1]!;
    expect(fixture.pointCount).toBe(TOTAL_POINTS);
    expect(firstFrameMounts).toBe(0);
    expect(renderer.mountedCount).toBe(STROKES);
    expect(renderer.mountedIds("highlight")).toEqual(fixture.highlightIds);
    expect(renderer.mountedIds("content")).toEqual(fixture.contentIds);
    expect(cameraGroup.nodes[3]?.nodes).toHaveLength(fixture.highlightIds.length);
    expect(cameraGroup.nodes[4]?.nodes).toHaveLength(fixture.contentIds.length);
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
        `firstFrameMounts=${String(firstFrameMounts)}`,
      "performance",
    );
    verifyEraserFeedback(renderer, scheduler, cameraGroup, fixture);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  });
});

function verifyEraserFeedback(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  cameraGroup: FakeNode,
  fixture: ReturnType<typeof createMaximumPointFixture>,
): void {
  const nodes = [...cameraGroup.nodes[3]!.nodes, ...cameraGroup.nodes[4]!.nodes];
  const styleWrites = observeFadeWrites(nodes);
  const before = renderer.instrumentation();
  const ids = [...fixture.contentIds, ...fixture.highlightIds];
  renderer.setElementFade(ids, 160);
  expect(styleWrites()).toBe(128 * 3);
  expect(scheduler.pendingCount).toBe(1);
  scheduler.runNext();
  expect(styleWrites()).toBe(128 * 3);
  while (scheduler.pendingCount > 0) {
    const beforeFrame = styleWrites();
    scheduler.runNext();
    expect(styleWrites() - beforeFrame).toBeLessThanOrEqual(128 * 3);
    expect(scheduler.pendingCount).toBeLessThanOrEqual(1);
  }
  expect(styleWrites()).toBe(STROKES * 3);
  expect(nodes.every((node) => node.style.filter === "blur(50px)")).toBe(true);
  expect(scheduler.pendingCount).toBe(0);
  renderer.clearElementFade(ids);
  expect(styleWrites()).toBe(STROKES * 6);
  expect(nodes.every((node) => node.style.filter === "")).toBe(true);
  const fadeFrames = Math.ceil(STROKES / 128);
  expect(renderer.instrumentation()).toEqual({
    ...before,
    frames: before.frames + fadeFrames,
    scheduledFrames: before.scheduledFrames + fadeFrames,
  });
  expect(scheduler.pendingCount).toBe(0);
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

it("bounds selected deletion filter writes for 10,000 mounted elements", () => {
  const records = Array.from({ length: 10_000 }, (_, index) =>
    fakeRectangleRecord(`selected-${index}`, index, 10),
  );
  const { renderer, scheduler, store } = createMountScene(records);
  scheduler.runAll(500);
  expect(renderer.mountedCount).toBe(records.length);
  const nodes = [...fakeNode(renderer.svg).nodes[1]!.nodes[4]!.nodes];
  const writes = observeFadeWrites(nodes);
  const before = renderer.instrumentation();
  const ids = records.map(({ id }) => id);
  renderer.setElementFade(ids, 300);
  expect(writes()).toBe(128 * 3);
  store.records.clear();
  renderer.applyDelta({
    affected: records.map(({ id, element }) => ({
      id,
      before: element,
      after: null,
      domains: ["visibility"],
    })),
  });
  renderer.clearElementFade(ids);
  expect(writes()).toBe(128 * 3);
  for (let frame = 0; scheduler.pendingCount > 0; frame += 1) {
    expect(frame).toBeLessThan(400);
    const previous = writes();
    scheduler.time += 1000 / 120;
    scheduler.runNext();
    expect(writes() - previous).toBeLessThanOrEqual(128 * 3);
    expect(scheduler.pendingCount).toBeLessThanOrEqual(1);
  }
  expect(writes()).toBe(records.length * 3);
  expect(renderer.mountedCount).toBe(0);
  expect(renderer.instrumentation()).toMatchObject({
    geometryBuilds: before.geometryBuilds,
    motionTombstones: 0,
    motionCacheEntries: 0,
  });
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

function observeFadeWrites(nodes: readonly FakeNode[]): () => number {
  let writes = 0;
  for (const node of nodes) {
    for (const property of ["transition", "filter", "opacity"]) {
      let value = node.style[property];
      Object.defineProperty(node.style, property, {
        get: () => value,
        set: (next: string) => {
          value = next;
          writes += 1;
        },
      });
    }
  }
  return () => writes;
}

function createMountScene(records: readonly SceneElementRecord[]) {
  const store = new FakeSceneStore();
  for (const record of records) store.records.set(record.id, record);
  return {
    store,
    ...createSceneFixture(PAGE, store, { height: 200, left: 0, top: 0, width: 200 }),
  };
}
