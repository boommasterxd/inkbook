import { afterEach, expect, it, vi } from "vitest";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { draining, expectCanonical } from "../../../../fixtures/rendering/selection-run-drain";
import {
  fixture,
  fixtureElement,
  contentPaths,
} from "../../../../fixtures/rendering/selection-runs";
import { rectangle } from "../../../../unit/domain/store/fixtures";
import { FakeNode, fakeNode } from "../../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";
import type { ScenePathPreparation } from "../../../../../src/domain/geometry/prepared-scene-paths";
import { ScenePathCache } from "../../../../../src/rendering/scene/content/path-cache";

afterEach(() => vi.restoreAllMocks());

it("retires inactive groups and culls before unavailable ordinary contours consume every slice", () => {
  const strokes = Array.from({ length: 10_000 }, (_, index) => ({
    ...indexedStroke(100_000 + index),
    pivot: { x: 60, y: 30 },
    points: [60, 30, 0.5, 65, 35, 1],
  }));
  const bridge = strokes[0]!;
  bridge.pivot = { x: 5060, y: 30 };
  bridge.points = [60, 30, 0.5, 10_060, 30, 1];
  const f = fixture(
    600,
    false,
    true,
    strokes,
    INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs,
  );
  const ordinary = new Set(strokes.map(({ id }) => id));
  const preparation = vi.spyOn(ScenePathCache.prototype, "startPreparation");
  const prepare = vi.fn<ScenePathPreparation>(() => undefined);
  f.port.prepareScenePaths = prepare;
  const update = mounted.updateMountedGeometry;
  const built: string[] = [];
  vi.spyOn(mounted, "updateMountedGeometry").mockImplementation((...args) => {
    update(...args);
    if (ordinary.has(args[0].id)) {
      built.push(args[0].id);
      f.scheduler.time += f.scheduler.workScheduler.budgetMs();
    }
  });
  try {
    expect(f.renderer.svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    f.renderer.setSelectedElements(new Set());
    const replacements = strokes.map((element) =>
      scaleElement(element, { x: 0, y: 0 }, { x: 1.5, y: 1 }),
    );
    f.renderer.applyDelta({ affected: sceneDeltaEntries(f.store.replaceMany(replacements)!) });
    const exits = f.renderer.instrumentation().domExits;
    f.renderer.setViewport({ left: 10_000, top: 0, width: 2048, height: 1000 });
    for (let frame = 0; frame < 4; frame += 1) {
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      f.scheduler.runFrame();
    }
    const removed = f.renderer.instrumentation().domExits - exits;
    expect(removed).toBeGreaterThanOrEqual(2 * 64);
    expect(removed).toBeLessThanOrEqual(4 * 64);
    expect(built.length).toBeLessThan(10_000);
    expect(built).toContain(bridge.id);
    expect(new Set(preparation.mock.calls.map(([element]) => element.id))).toEqual(
      new Set([bridge.id]),
    );
    const bridgePath = buildElementPathParts(replacements[0]!)[0]!.d;
    expect(
      contentPaths(fakeNode(f.renderer.svg)).some((node) => node.getAttribute("d") === bridgePath),
    ).toBe(true);
    expect(f.renderer.mountedCount).toBeGreaterThan(1);
    // Reverse before physical retirement finishes; retained dirty IDs must still catch up.
    f.renderer.setViewport({ left: 0, top: 0, width: 2048, height: 1000 });
    f.scheduler.runAll(20_000);
    expectCanonical(f);
    const completed = preparation.mock.calls.length;
    f.renderer.setViewport({ left: 10_000, top: 0, width: 2048, height: 1000 });
    f.scheduler.runAll(1000);
    expect(f.renderer.mountedIds("content")).toEqual([bridge.id]);
    expect(contentPaths(fakeNode(f.renderer.svg))).toHaveLength(1);
    expect(preparation).toHaveBeenCalledTimes(completed);
    const required = prepare.mock.calls.filter(([, , options]) => options?.speculative !== true);
    expect(required.length).toBeLessThanOrEqual(10_000);
    expect(prepare.mock.calls.length - required.length).toBeLessThanOrEqual(1);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
  expect(f.scheduler.pendingCount).toBe(0);
});

it("admits newly visible entrants before finishing an offscreen canonical cohort", () => {
  const distant = Array.from({ length: 3 }, (_, index) =>
    rectangle(indexedStroke(100_000 + index).id, 50, 10_000 + index * 120),
  );
  const distantIds = new Set(distant.map((e) => e.id));
  const f = draining(distant, 2, false, INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  try {
    expect(f.renderer.mountedIds("content").some((id) => distantIds.has(id))).toBe(false);
    f.scheduler.frameBudgetMs = 1;
    f.renderer.setViewport({ left: 0, top: 10_000, width: 2048, height: 1000 });
    const canonicalIds = () =>
      new Set(f.writes.filter((id) => f.ids.includes(id) && !f.pens.includes(id)));
    let frames = 0;
    while (
      !f.renderer.mountedIds("content").some((id) => distantIds.has(id)) &&
      canonicalIds().size < f.ids.length - f.pens.length
    ) {
      expect(frames++).toBeLessThan(1000);
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      f.scheduler.runFrame();
    }
    expect(canonicalIds().size).toBeLessThan(f.ids.length - f.pens.length);
    expect(f.renderer.mountedIds("content").some((id) => distantIds.has(id))).toBe(true);
    const atAdmission = f.writes.length;
    f.scheduler.runAll(1000);
    expect(f.writes.length).toBe(atAdmission);
    expect(new Set(f.renderer.mountedIds("content"))).toEqual(distantIds);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("does not admit extra mixed geometry work after real group finalization exhausts the shared frame", () => {
  const f = draining([], 2, false, INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  try {
    f.scheduler.frameBudgetMs = 1;
    let steps = 0;
    while (
      new Set(f.writes.filter((id) => !f.pens.includes(id))).size <
      f.ids.length - f.pens.length
    ) {
      expect(steps++).toBeLessThan(1000);
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      f.scheduler.runFrame();
    }
    const lateIds = [f.elements[1]!.id, f.elements[3]!.id, ...f.pens];
    const lateMixed = lateIds.map((id) =>
      scaleElement(fixtureElement(f, id), { x: 0, y: 0 }, { x: 1.5, y: 1 }),
    );
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany(lateMixed)!),
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The observation wrapper forwards the actual node through call.
    const insert = FakeNode.prototype.insertBefore;
    let finalizations = 0;
    let finalizedInFrame = false;
    let extraGeometry = 0;
    vi.spyOn(FakeNode.prototype, "insertBefore").mockImplementation(function (
      this: FakeNode,
      node,
      reference,
    ) {
      const result = insert.call(this, node, reference);
      if (node.tagName === "g" && node.nodes.length === 0 && reference?.tagName === "g") {
        finalizations += 1;
        finalizedInFrame = true;
        f.scheduler.time += 1;
      }
      return result;
    });
    const previousGeometry = f.geometry.getMockImplementation()!;
    vi.spyOn(mounted, "updateMountedGeometry").mockImplementation((...args) => {
      if (finalizedInFrame) extraGeometry += 1;
      previousGeometry(...args);
    });
    for (let frame = 0; finalizations === 0; frame += 1) {
      expect(frame).toBeLessThan(10);
      finalizedInFrame = false;
      f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
      f.scheduler.runFrame();
    }
    expect(extraGeometry).toBe(0);
    f.scheduler.runAll(1000);
    expectCanonical(f);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});
