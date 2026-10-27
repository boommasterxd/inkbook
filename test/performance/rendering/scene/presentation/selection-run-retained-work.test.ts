import { afterEach, expect, it, vi } from "vitest";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import {
  commitSelectionMove,
  commitSelectionScale,
  contentPaths,
  fixture,
  observeSelectionInsertions,
  startSelectionResize,
} from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

function normalizeResize(f: ReturnType<typeof fixture>): void {
  startSelectionResize(f);
  commitSelectionScale(f, 2);
  f.scheduler.runAll();
}

it.each([false, true])(
  "keeps prepared and normalized idle zoom on natural stroke paint without inherited palette writes (dashed=%s)",
  (dashed) => {
    const f = fixture(600, dashed);
    try {
      for (const normalized of [false, true]) {
        if (normalized) normalizeResize(f);
        const svg = fakeNode(f.renderer.svg);
        const paths = contentPaths(svg);
        expect(paths.length).toBe(f.elements.length);
        const inheritedWrite = vi.spyOn(svg.style, "setProperty");
        const inheritedRemove = vi.spyOn(svg.style, "removeProperty");
        const geometry = vi.spyOn(mounted, "updateMountedGeometry");
        const reparent = vi.spyOn(mounted, "appendElementToFragment");
        for (const zoom of [0.5, 2, 1]) {
          f.renderer.setCamera({ x: 0, zoom });
          f.renderer.flushPointerFeedbackFrame();
          f.scheduler.runAll();
          expect(svg.nodes[1]!.getAttribute("transform")).toContain(`scale(${zoom})`);
        }
        expect(inheritedWrite.mock.calls.filter(([name]) => name.startsWith("--"))).toEqual([]);
        expect(inheritedRemove.mock.calls.filter(([name]) => name.startsWith("--"))).toEqual([]);
        expect(geometry.mock.calls.length).toBe(0);
        expect(reparent.mock.calls.length).toBe(0);
        for (const path of paths) {
          expect(path.style.getPropertyValue("vector-effect")).toBe("");
          expect(path.style.getPropertyValue("stroke-width")).toBe("");
          expect(path.style.getPropertyValue("stroke-dasharray")).toBe("");
          for (
            let parent = path.parent;
            parent !== undefined && parent !== svg;
            parent = parent.parent
          ) {
            expect(parent.getAttribute("data-inkbook-run-active")).toBeNull();
          }
        }
        inheritedWrite.mockRestore();
        inheritedRemove.mockRestore();
        geometry.mockRestore();
        reparent.mockRestore();
      }
    } finally {
      f.renderer.destroy();
      f.port.release();
    }
  },
);

it("retains prepared path parents across a pure Move commit without regrouping member roots", () => {
  const f = fixture();
  try {
    const paths = contentPaths(fakeNode(f.renderer.svg));
    const parents = paths.map((path) => path.parent);
    const memberInsertions = observeSelectionInsertions(new Set(paths));
    f.renderer.setPreviewTransform(f.ids, "translate(5 3)", 1);
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    const moved = moveSelection(f.selected, { x: 5, y: 3 });
    commitSelectionMove(f, f.ids, moved);
    f.scheduler.runAll();
    expect(memberInsertions).toHaveLength(0);
    expect(
      contentPaths(fakeNode(f.renderer.svg)).every((path, index) => path === paths[index]),
    ).toBe(true);
    expect(paths.every((path, index) => path.parent === parents[index])).toBe(true);
    for (const e of moved) expect(f.store.get(e.id)?.element).toEqual(e);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});
