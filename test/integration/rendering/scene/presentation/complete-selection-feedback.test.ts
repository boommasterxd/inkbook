import { describe, expect, it } from "vitest";
import {
  buildElementPathParts,
  calculateElementBounds,
} from "../../../../../src/domain/geometry/public";
import { strokeLocalGeometry } from "../../../../../src/domain/geometry/stroke-position";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import { createDenseSelectionPreview } from "../../../../fixtures/rendering/selection-preview";

describe("complete pressure preview commit handoff", () => {
  it("hands off all 300 pressure paths when only 256 canonical snapshots were prepared", () => {
    const { renderer, scheduler, ids, nodes, store, untouched } = createDenseSelectionPreview(300);
    const unchanged = untouched.map((node) => new Map(node.attributes));
    const replacements = new Map(
      ids.map((id) => [id, scaleElement(store.get(id)!.element, { x: 0, y: 0 }, { x: 2, y: 1 })]),
    );
    try {
      renderer.setProgressiveElementPreviews(ids, (id) => replacements.get(id), 1, {
        transform: "scale(2 1)",
        inverse: "scale(0.5 1)",
      });
      renderer.flushPointerFeedbackFrame(scheduler.time);
      scheduler.runAll();
      const handoff = renderer.beginPreviewCommit();
      renderer.clearProgressiveElementPreviews();
      expect(handoff.arm(ids)).toBe(true);
      const affected = ids.map((id) => {
        const before = store.get(id)!;
        const after = replacements.get(id)!;
        store.records.set(id, {
          ...before,
          element: after,
          bounds: calculateElementBounds(after),
          geometryVersion: 2,
        });
        return { id, before: before.element, after, domains: ["geometry" as const] };
      });
      renderer.applyDelta({ affected });
      scheduler.runAll();
      for (const id of ids) {
        const element = replacements.get(id)!;
        if (element.kind !== "stroke") throw new Error("Expected a stroke");
        const node = nodes.get(id)!;
        expect(node.attributes.get("d")).toBe(
          buildElementPathParts(strokeLocalGeometry(element))[0]!.d,
        );
        expect(node.attributes.get("transform") ?? "").not.toContain("scale");
      }
      expect(untouched.map((node) => node.attributes)).toEqual(unchanged);
    } finally {
      renderer.destroy();
    }
  });
});
describe("complete mounted selection feedback", () => {
  it.each([255, 256, 257, 300])(
    "moves and rotates every visible selected path at capacity %i",
    (count) => {
      const fixture = createDenseSelectionPreview(count);
      const { renderer, scheduler, ids, selectedNodes, untouched } = fixture;
      renderer.setSelectedElements(new Set(ids));
      scheduler.runAll();
      const parents = [...selectedNodes, ...untouched].map((node) => node.parent);
      const untouchedState = untouched.map((node) => new Map(node.attributes));
      const original = selectedNodes.map((node) => new Map(node.attributes));
      try {
        for (const [index, transform] of ["translate(12 8)", "rotate(30 21 21)"].entries()) {
          renderer.setPreviewTransform(ids, transform, index + 1);
          renderer.flushPointerFeedbackFrame();
          expect(
            selectedNodes.every((node) => node.attributes.get("transform") === transform),
          ).toBe(true);
          expect(untouched.map((node) => node.attributes)).toEqual(untouchedState);
          expect([...selectedNodes, ...untouched].map((node) => node.parent)).toEqual(parents);
        }
        renderer.clearPreviewTransforms();
        scheduler.runAll();
        expect(selectedNodes.map((node) => node.attributes)).toEqual(original);
      } finally {
        renderer.destroy();
      }
    },
  );

  it.each([false, true])(
    "keeps 300 resize paths coherent before snapshots (pressure=%s)",
    (pressure) => {
      const fixture = createDenseSelectionPreview(300, pressure);
      const { renderer, scheduler, ids, selectedNodes, untouched, store } = fixture;
      const original = selectedNodes.map((node) => new Map(node.attributes));
      const untouchedState = untouched.map((node) => new Map(node.attributes));
      try {
        renderer.setProgressiveElementPreviews(
          ids,
          (id) => {
            const element = store.get(id)?.element;
            return element === undefined
              ? undefined
              : scaleElement(element, { x: 0, y: 0 }, { x: 2, y: 1 });
          },
          1,
          { transform: "scale(2 1)", inverse: "scale(0.5 1)" },
        );
        renderer.flushPointerFeedbackFrame(scheduler.time);
        expect(
          selectedNodes.every((node) => node.attributes.get("transform") === "scale(2 1)"),
        ).toBe(true);
        expect(untouched.map((node) => node.attributes)).toEqual(untouchedState);
        renderer.clearProgressiveElementPreviews();
        scheduler.runAll();
        expect(selectedNodes.map((node) => node.attributes)).toEqual(original);
      } finally {
        renderer.destroy();
      }
    },
  );
});
