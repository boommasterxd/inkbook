import { afterEach, expect, it, vi } from "vitest";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import {
  contentPaths,
  fixture,
  fixtureElement,
  observeSelectionInsertions,
  paintedX,
} from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";
import { INTERACTION_REFRESH_PROFILE } from "../../../interaction-refresh-profile";

afterEach(() => vi.restoreAllMocks());

it("preserves one ordinary geometry admission when camera publication consumes the shared frame", () => {
  const f = fixture(1, false, true, [], INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  try {
    const root = fakeNode(f.renderer.svg).nodes[1]!;
    const setAttribute = root.setAttribute.bind(root);
    const cameraWrites: string[] = [];
    vi.spyOn(root, "setAttribute").mockImplementation((name, value) => {
      setAttribute(name, value);
      if (name === "transform") {
        cameraWrites.push(value);
        f.scheduler.time += f.scheduler.workScheduler.budgetMs();
      }
    });
    const target = f.selected[f.selected.length - 1]!;
    const replacement = scaleElement(target, { x: 0, y: 0 }, { x: 2, y: 1 });
    const geometry = vi.spyOn(mounted, "updateMountedGeometry");
    f.renderer.suppressMotionForNextDelta([target.id]);
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany([replacement])!),
    });
    f.renderer.setCamera({ x: 0, zoom: 2 });
    f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    f.scheduler.runFrame();
    expect(cameraWrites.length).toBe(1);
    expect(geometry.mock.calls.filter(([entry]) => entry.id === target.id).length).toBe(1);
    f.scheduler.runAll();
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("retains the coalesced preparation successor when the last paint publication exhausts the frame", () => {
  const f = fixture(600, false, true, [], INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs);
  try {
    f.renderer.setReducedMotion(true);
    f.scheduler.runAll();
    const svg = fakeNode(f.renderer.svg);
    expect(svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    const paths = contentPaths(svg);
    const memberInsertions = observeSelectionInsertions(new Set(paths));
    const updatePaint = mounted.updateMountedPaint;
    const paint = vi.spyOn(mounted, "updateMountedPaint").mockImplementation((...args) => {
      updatePaint(...args);
      f.scheduler.time += f.scheduler.workScheduler.budgetMs();
    });
    const target = f.selected[f.selected.length - 1]!;
    if (target.kind !== "rectangle") throw new Error("Expected the fixture's last rectangle.");
    const delta = f.store.updateStyle(target.id, {
      ...target.style,
      outlineColor: { type: "theme-text" },
    })!;
    expect(delta.changes[0]!.domains).toEqual(["paint"]);
    f.renderer.applyDelta({ affected: sceneDeltaEntries(delta) });
    f.scheduler.time += INTERACTION_REFRESH_PROFILE.frameDurationMs;
    f.scheduler.runFrame();
    expect(paint.mock.calls.length).toBe(1);
    expect(memberInsertions).toHaveLength(0);
    expect(svg.getAttribute("data-inkbook-run-ready")).toBeNull();
    expect(f.scheduler.pendingCount).toBe(1);
    f.scheduler.runAll(1000);
    expect(
      svg.getAttribute("data-inkbook-run-ready"),
      JSON.stringify({
        fallback: svg.getAttribute("data-inkbook-run-fallback"),
        pending: f.scheduler.pendingCount,
        mounted: f.renderer.mountedCount,
      }),
    ).toBe("true");
    expect(f.scheduler.pendingCount).toBe(0);
    const values = new Map(
      f.ids.map((id) => [id, scaleElement(fixtureElement(f, id), { x: 0, y: 0 }, { x: 2, y: 1 })]),
    );
    const shape = paths[paths.length - 1]!;
    const band = svg.nodes[1]!.nodes[4]!;
    const before = paintedX(shape, band);
    f.renderer.setProgressiveElementPreviews(f.ids, (id) => values.get(id), 1, f.feedback);
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    expect(paintedX(shape, band)).toBeCloseTo(before * 2, 6);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});
