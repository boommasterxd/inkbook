import { afterEach, expect, it, vi } from "vitest";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { draining, expectCanonical } from "../../../../fixtures/rendering/selection-run-drain";
import { fixtureElement } from "../../../../fixtures/rendering/selection-runs";
import { rectangle } from "../../../../unit/domain/store/fixtures";
import { FakeNode } from "../../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";

afterEach(() => vi.restoreAllMocks());

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
