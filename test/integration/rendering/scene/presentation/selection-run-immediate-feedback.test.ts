import { afterEach, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import { draining } from "../../../../fixtures/rendering/selection-run-drain";
import {
  contentPaths,
  fixture,
  paintedX,
  scaleFeedback,
  startSelectionResize,
} from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

function target(f: ReturnType<typeof fixture>) {
  const last = f.selected[f.selected.length - 1]!;
  const svg = fakeNode(f.renderer.svg);
  const node = contentPaths(svg).find(
    (path) => path.getAttribute("d") === buildElementPathParts(last)[0]!.d,
  )!;
  expect(node).toBeDefined();
  return { last, node, band: svg.nodes[1]!.nodes[4]! };
}

it.each([
  [2, false],
  [2, true],
  [0, true],
] as const)(
  "publishes immediate Move feedback during a resize drain (factor=%s, foreignSubset=%s)",
  (factor, foreignSubset) => {
    const f = draining([], factor);
    try {
      const { last, node, band } = target(f);
      const before = paintedX(node, band);
      const ids = foreignSubset ? [last.id] : f.ids;
      if (foreignSubset) f.renderer.setSelectedElements(new Set(ids));
      f.renderer.setPreviewTransform(ids, "translate(10 0)", 2);
      f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
      expect(paintedX(node, band)).toBeCloseTo(before + 10, 6);
    } finally {
      f.geometry.mockRestore();
      f.renderer.destroy();
      f.port.release();
    }
  },
);

it("publishes collapsed scale before another scene frame after invertible feedback", () => {
  const f = fixture();
  try {
    startSelectionResize(f);
    const { node, band } = target(f);
    const values = new Map(
      f.selected.map((element) => [
        element.id,
        scaleElement(element, { x: 0, y: 0 }, { x: 0, y: 1 }),
      ]),
    );
    f.renderer.setProgressiveElementPreviews(
      f.ids,
      (id) => values.get(id),
      2,
      scaleFeedback(f.selection, 0),
    );
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    expect(paintedX(node, band)).toBe(0);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});
