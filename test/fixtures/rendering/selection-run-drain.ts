import { expect, vi } from "vitest";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../src/domain/geometry/stroke-position";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import * as mounted from "../../../src/rendering/scene/content/mounted-element";
import { fakeNode } from "../../unit/rendering/scene/fakes";
import { commitSelectionScale, contentPaths, fixture, fixtureElement } from "./selection-runs";

export function draining(
  additional: readonly InkElementV1[] = [],
  factor = 2,
  dashed = false,
  frameBudgetMs = 8,
) {
  const f = fixture(600, dashed, true, additional, frameBudgetMs);
  f.factor.value = factor;
  const feedback = {
    ...f.feedback,
    invertible: factor !== 0,
    matrix: [factor, 0, 0, 1, 0, 0] as const,
    transform: `scale(${factor} 1)`,
    inverse: factor === 0 ? "" : `scale(${1 / factor} 1)`,
  };
  f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 1, feedback);
  f.renderer.flushPointerFeedbackFrame(0);
  f.scheduler.runAll();
  const original = mounted.updateMountedGeometry;
  const writes: string[] = [];
  const geometry = vi.spyOn(mounted, "updateMountedGeometry").mockImplementation((...args) => {
    writes.push(args[0].id);
    original(...args);
    f.scheduler.time += 1;
  });
  commitSelectionScale(f, factor);
  f.scheduler.runFrame();
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.length).toBeLessThan(f.ids.length);
  expect(f.scheduler.pendingCount).toBeGreaterThan(0);
  return { ...f, writes, geometry };
}

export function expectCanonical(f: ReturnType<typeof fixture>): void {
  const svg = fakeNode(f.renderer.svg);
  const expected = f.store.materializeBandOrder("content").flatMap((id) => {
    const e = fixtureElement(f, id);
    return buildElementPathParts(e.kind === "stroke" ? strokeLocalGeometry(e) : e).map(
      (part) => part.d,
    );
  });
  const actual = contentPaths(svg);
  expect(actual.length).toBe(expected.length);
  const mismatch = actual.findIndex((path, index) => path.getAttribute("d") !== expected[index]);
  expect(
    mismatch,
    mismatch < 0
      ? "canonical paths"
      : `path ${mismatch}: ${actual[mismatch]!.getAttribute("d")} expected ${expected[mismatch]}`,
  ).toBe(-1);
  expect(new Set(actual).size).toBe(actual.length);
  expect(svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
}
