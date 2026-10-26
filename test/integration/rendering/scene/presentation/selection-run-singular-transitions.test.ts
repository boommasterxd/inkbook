import { afterEach, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../../../src/domain/geometry/stroke-position";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  moveSelection,
  scaleElement,
} from "../../../../../src/editor/selection/transform/transforms";
import { draining, expectCanonical } from "../../../../fixtures/rendering/selection-run-drain";
import {
  commitSelectionMove,
  commitSelectionScale,
  contentPaths,
  fixture,
  fixtureElement,
  paintedX,
  scaleFeedback,
} from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

function pathOf(f: ReturnType<typeof fixture>, element: InkElementV1) {
  const parts = buildElementPathParts(
    element.kind === "stroke" ? strokeLocalGeometry(element) : element,
  );
  const node = contentPaths(fakeNode(f.renderer.svg)).find(
    (path) => path.getAttribute("d") === parts[0]!.d,
  );
  expect(node).toBeDefined();
  return node!;
}

function publishScale(f: ReturnType<typeof fixture>, factor: number, version: number): void {
  f.factor.value = factor;
  f.renderer.setProgressiveElementPreviews(
    f.ids,
    f.materialize,
    version,
    scaleFeedback(f.selection, factor),
  );
  f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
  f.scheduler.runAll(1000);
}

function commitScale(f: ReturnType<typeof fixture>, factor: number): void {
  commitSelectionScale(f, factor);
  f.scheduler.runAll(1000);
  expectCanonical(f);
}

it("recovers pressure snapshots and shared feedback through repeated zero to positive transitions before one commit", () => {
  const f = fixture();
  try {
    const last = f.selected[f.selected.length - 1]!;
    const shape = pathOf(f, last);
    const svg = fakeNode(f.renderer.svg);
    const band = svg.nodes[1]!.nodes[4]!;
    for (const [index, factor] of [2, 0, 3, 0, 2].entries()) {
      publishScale(f, factor, index + 1);
      expect(paintedX(shape, band)).toBeCloseTo(
        Number(/^M\s*([-\d.]+)/.exec(buildElementPathParts(last)[0]!.d)![1]) * factor,
        6,
      );
      if (factor !== 0) {
        for (const id of f.pens) {
          const expected = scaleElement(
            f.selected.find((e) => e.id === id)!,
            { x: 0, y: 0 },
            { x: factor, y: 1 },
          );
          const pressure = pathOf(f, expected);
          expect(paintedX(pressure, band)).toBeCloseTo(
            Number(/^M\s*([-\d.]+)/.exec(pressure.getAttribute("d")!)![1]),
            6,
          );
        }
      }
    }
    commitScale(f, 2);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("reopens an overlapping cohort after a zero commit and moves its pressure and collapsed shape without stale feedback", () => {
  const f = fixture();
  try {
    const pressure = pathOf(
      f,
      f.selected.find((e) => e.id === f.pens[1])!,
    );
    const shape = pathOf(f, f.selected[f.selected.length - 1]!);
    publishScale(f, 0, 1);
    commitScale(f, 0);
    const ids = [...f.ids.slice(1), f.elements[1]!.id];
    f.renderer.setSelectedElements(new Set(ids));
    f.scheduler.runAll(1000);
    const svg = fakeNode(f.renderer.svg);
    const band = svg.nodes[1]!.nodes[4]!;
    const before = [paintedX(pressure, band), paintedX(shape, band)];
    f.renderer.setPreviewTransform(
      ids,
      "translate(10 0)",
      2,
      "scale",
      undefined,
      [1, 0, 0, 1, 10, 0],
    );
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    expect(paintedX(pressure, band)).toBeCloseTo(before[0]! + 10, 6);
    expect(paintedX(shape, band)).toBeCloseTo(before[1]! + 10, 6);
    const moved = moveSelection(
      ids.map((id) => fixtureElement(f, id)),
      { x: 10, y: 0 },
    );
    commitSelectionMove(f, ids, moved);
    f.scheduler.runAll(1000);
    expectCanonical(f);
    expect(paintedX(pressure, band)).toBeCloseTo(before[0]! + 10, 6);
    expect(paintedX(shape, band)).toBeCloseTo(before[1]! + 10, 6);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("cancels a zero-scale gesture back to the prior committed world while its canonical drain is partial", () => {
  const f = draining();
  try {
    const shape = pathOf(f, f.selected[f.selected.length - 1]!);
    const pressure = pathOf(f, fixtureElement(f, f.pens[0]!));
    const band = fakeNode(f.renderer.svg).nodes[1]!.nodes[4]!;
    const before = [paintedX(shape, band), paintedX(pressure, band)];
    const committed = f.ids.map((id) => fixtureElement(f, id));
    const collapsed = new Map(
      committed.map((e) => [e.id, scaleElement(e, { x: 0, y: 0 }, { x: 0, y: 1 })]),
    );
    f.renderer.setProgressiveElementPreviews(
      f.ids,
      (id) => collapsed.get(id),
      2,
      scaleFeedback(f.selection, 0),
    );
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    expect(paintedX(shape, band)).toBe(0);
    expect(paintedX(pressure, band)).toBe(0);
    f.renderer.clearPreviewTransforms();
    f.renderer.clearElementPreviews();
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    expect(paintedX(shape, band)).toBeCloseTo(before[0]!, 6);
    expect(paintedX(pressure, band)).toBeCloseTo(before[1]!, 6);
    for (const element of committed) expect(f.store.get(element.id)!.element).toBe(element);
    f.scheduler.runAll(1000);
    expectCanonical(f);
    expect(paintedX(shape, band)).toBeCloseTo(before[0]!, 6);
    expect(paintedX(pressure, band)).toBeCloseTo(before[1]!, 6);
  } finally {
    f.geometry.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});
