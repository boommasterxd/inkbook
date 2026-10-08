import { ScenePathCache } from "../../../../src/rendering/scene/path-cache";
import { SCENE_PUBLICATION_ROOTS_PER_FRAME } from "../../../../src/rendering/scene/constants";
import * as geometry from "../../../../src/domain/geometry/element-path";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import { describe, expect, it, vi } from "vitest";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { flushBoundedScenePublication } from "../../../fixtures/rendering/scene-publication";
import { observePointReads } from "../../../fixtures/rendering/point-reads";

import type { PageV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { type SceneElementRecord } from "../../../../src/rendering/scene/types";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  type FakeScheduler,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

const STROKES = 489;
const FIXTURE_STROKE_POINTS = 4_096;
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
  it("admits multiple maximum strokes while the shared deadline has room", () => {
    const records = [
      strokeRecord(0, strokePoints(MAX_STROKE_POINTS)),
      strokeRecord(1, strokePoints(MAX_STROKE_POINTS)),
    ];
    const { renderer, scheduler } = createMountScene(records);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(2);
    const work = renderer.instrumentation();
    expect(work.geometryBuilds).toBe(2);
    // Priority, retained-order proof, readiness, and publication each visit at most once.
    expect(work.maximumMountSliceElements).toBeLessThanOrEqual(records.length * 4);
    expect(work.mountBudgetYields).toBe(0);
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
  });

  it("resumes 489 visible strokes with exactly two million points in stable band order", async ({
    annotate,
  }) => {
    const shadowRoots = vi.spyOn(FakeNode.prototype, "attachShadow");
    const elements = vi.spyOn(FakeDocument.prototype, "createElementNS");
    const actualBuilds = vi.spyOn(geometry, "buildElementPathParts");
    const preparations = vi.spyOn(ScenePathCache.prototype, "startPreparation");
    const fixture = createMaximumPointFixture();
    const { renderer, scheduler } = createMountScene(fixture.records);
    const input = fakeNode(renderer.inputSurface);
    const container = input.parent!;
    const host = container.nodes[0]!;
    const resources = () => sceneResources(elements.mock.calls, elements.mock.results);
    const frame = host.shadowRoot!.nodes[1]!;
    expect(shadowRoots).toHaveBeenCalledTimes(1);
    expect(shadowRoots).toHaveBeenCalledWith({ mode: "open" });
    expect(frame.tagName).toBe("iframe");
    expect(frame.contentDocument?.body.nodes).toEqual([fakeNode(renderer.svg)]);
    expect(frame.contentDocument).not.toBe(host.ownerDocument);
    expect(fakeNode(renderer.svg).ownerDocument).toBe(frame.contentDocument);
    expect(input.ownerDocument).toBe(host.ownerDocument);
    expect(resources()).toEqual({ documents: 1, frames: 1, hosts: 2, styles: 3 });
    scheduler.runNext();
    const firstFrameMounts = renderer.mountedCount;
    flushBoundedScenePublication(renderer, scheduler);

    expect(actualBuilds).toHaveBeenCalledTimes(0);
    expect(preparations).toHaveBeenCalledTimes(3);
    actualBuilds.mockRestore();
    preparations.mockRestore();
    const instrumentation = renderer.instrumentation();
    const cameraGroup = fakeNode(renderer.svg).nodes[1]!;
    expect(fixture.pointCount).toBe(TOTAL_POINTS);
    expect(firstFrameMounts).toBe(SCENE_PUBLICATION_ROOTS_PER_FRAME);
    expect(renderer.mountedCount).toBe(STROKES);
    expect(renderer.mountedIds("highlight")).toEqual(fixture.highlightIds);
    expect(renderer.mountedIds("content")).toEqual(fixture.contentIds);
    expect(cameraGroup.nodes[3]?.nodes).toHaveLength(fixture.highlightIds.length);
    expect(cameraGroup.nodes[4]?.nodes).toHaveLength(fixture.contentIds.length);
    expect(instrumentation).toMatchObject({
      domEntrants: STROKES,
      geometryBuilds: 3,
      spatialQueries: 1,
    });
    expect(instrumentation.domFragmentRuns).toBeGreaterThan(0);
    // Candidate/proof/readiness bookkeeping uses the shared deadline; only live roots
    // have a fixed browser-publication capacity, checked above at the actual mount boundary.
    expect(instrumentation.maximumMountSliceElements).toBeLessThanOrEqual(
      STROKES * 3 + SCENE_PUBLICATION_ROOTS_PER_FRAME,
    );
    expect(instrumentation.mountBudgetYields).toBeGreaterThan(0);
    expect(instrumentation.pathCacheHits).toBeGreaterThanOrEqual(STROKES - 3);
    expect(fixture.pointReads()).toBeGreaterThan(0);
    expect(fixture.pointReads()).toBeLessThanOrEqual(FIXTURE_STROKE_POINTS * 100);
    await annotate(
      `render mount slices=${String(instrumentation.mountSlices)}, ` +
        `firstFrameMounts=${String(firstFrameMounts)}`,
      "performance",
    );
    verifyEraserFeedback(renderer, scheduler, cameraGroup, fixture);
    verifyNavigationResources(renderer, scheduler, () => elements.mock.calls.length);
    expect(shadowRoots).toHaveBeenCalledTimes(1);
    expect(resources()).toEqual({ documents: 1, frames: 1, hosts: 2, styles: 3 });
    expect(ownedSceneNodes(fakeNode(renderer.svg))).toBe(true);
    renderer.destroy();
    expect(container.nodes).toHaveLength(0);
    expect(host.shadowRoot?.nodes).toHaveLength(0);
    expect([...input.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
    shadowRoots.mockRestore();
    elements.mockRestore();
  });
});

function sceneResources(
  calls: readonly (readonly [string, string])[],
  results: readonly { readonly value?: unknown }[],
) {
  const count = (name: string) => calls.filter(([, tag]) => tag === name).length;
  const documents = new Set(
    results.flatMap((result, index) =>
      calls[index]?.[1] === "iframe" ? [(result.value as FakeNode).contentDocument] : [],
    ),
  );
  return {
    documents: documents.size,
    frames: count("iframe"),
    hosts: count("div"),
    styles: count("style"),
  };
}

function verifyNavigationResources(
  renderer: SvgSceneRenderer,
  scheduler: FakeScheduler,
  nodesCreated: () => number,
): void {
  const before = nodesCreated();
  renderer.setCamera({ x: 1, zoom: 1.01 });
  renderer.setViewport({ height: 200, left: 0, top: 1, width: 200 });
  scheduler.runAll();
  expect(nodesCreated()).toBe(before);
}

function ownedSceneNodes(node: FakeNode, document = node.ownerDocument): boolean {
  return (
    node.ownerDocument === document && node.nodes.every((child) => ownedSceneNodes(child, document))
  );
}

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
  expect(cameraGroup.nodes[3]!.nodes.every((node) => node.style.filter === "blur(50px)")).toBe(
    true,
  );
  expect(cameraGroup.nodes[4]!.nodes.every((node) => node.style.filter === "blur(20px)")).toBe(
    true,
  );
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
  readonly pointReads: () => number;
  readonly records: readonly SceneElementRecord[];
} {
  let reads = 0;
  const observe = (points: number[]) =>
    observePointReads(points, () => {
      reads += 1;
    });
  const maximumPoints = observe(strokePoints(FIXTURE_STROKE_POINTS));
  const finalPoints = observe(strokePoints(FINAL_STROKE_POINTS));
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
  return { contentIds, highlightIds, pointCount, pointReads: () => reads, records };
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
  // Match immutable authoritative store ownership without changing any fixture samples.
  Object.freeze(points);
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
    for (const property of ["animation", "filter", "opacity"]) {
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
