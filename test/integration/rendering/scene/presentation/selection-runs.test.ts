import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../../../src/domain/geometry/stroke-position";
import {
  moveSelection,
  rotateSelection,
  scaleElement,
} from "../../../../../src/editor/selection/transform/transforms";
import * as mountedElements from "../../../../../src/rendering/scene/content/mounted-element";
import { SceneRunStrokeWidth } from "../../../../../src/rendering/scene/presentation/selection-run-width";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { expectCanonical } from "../../../../fixtures/rendering/selection-run-drain";
import {
  applySelectionDelta,
  armSelectionCommit,
  commitSelectionScale,
  startSelectionResize,
} from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

import { contentPaths, fixture } from "../../../../fixtures/rendering/selection-runs";

it("uses a prepared real SVG run while prioritizing both pressure exceptions within the existing snapshot cohort", () => {
  const f = fixture();
  const widthPrepare = vi.spyOn(SceneRunStrokeWidth.prototype, "prepare");
  try {
    const svg = fakeNode(f.renderer.svg);
    expect(svg.attributes.get("data-inkbook-run-ready")).toBe("true");
    expect(Object.values(f.renderer.memoryUsage()).every(Number.isFinite)).toBe(true);
    f.renderer.resetInstrumentation();
    f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 1, f.feedback);
    f.renderer.flushPointerFeedbackFrame(0);
    expect(svg.attributes.get("data-inkbook-run-feedback")).toBe("true");
    expect(f.renderer.instrumentation().contentGeometryWrites).toBeLessThan(100);
    expect(f.renderer.instrumentation().domReorders).toBe(0);
    expect(f.renderer.instrumentation().domRootsPublished).toBe(0);
    expect(widthPrepare).not.toHaveBeenCalled();
    f.scheduler.runAll();
    expect(widthPrepare).toHaveBeenCalledTimes(254);
    expect(new Set(f.materialize.mock.calls.map(([id]) => id)).size).toBeLessThanOrEqual(256);
    for (const id of f.pens)
      expect(f.materialize.mock.calls.some(([current]) => current === id)).toBe(true);
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    expect(svg.attributes.has("data-inkbook-run-feedback")).toBe(false);
  } finally {
    widthPrepare.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("freezes the run and retains pressure residuals across commit while canonical normalization uses admitted slices", () => {
  const f = fixture();
  let geometryWrites:
    import("vitest").MockInstance<typeof mountedElements.updateMountedGeometry> | undefined;
  try {
    startSelectionResize(f);
    const prior = f.selected[0]!;
    const e2 = scaleElement(prior, { x: 0, y: 0 }, { x: 2, y: 1 });
    const penD = buildElementPathParts(e2.kind === "stroke" ? strokeLocalGeometry(e2) : e2)[0]!.d;
    const penNode = contentPaths(fakeNode(f.renderer.svg)).find(
      (node) => node.attributes.get("d") === penD,
    )!;
    expect(penNode).toBeDefined();
    f.factor.value = 3;
    const latest = {
      ...f.feedback,
      transform: "scale(3 1)",
      matrix: [3, 0, 0, 1, 0, 0] as const,
      inverse: "scale(0.3333333333333333 1)",
    };
    f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 2, latest);
    f.renderer.flushPointerFeedbackFrame(0);
    expect(penNode.attributes.get("transform")).toBe("matrix(1.5 0 0 1 0 0)");
    armSelectionCommit(f);
    const replacements = f.selected.map((e) => scaleElement(e, { x: 0, y: 0 }, { x: 3, y: 1 }));
    const delta = f.store.replaceMany(replacements)!;
    const original = mountedElements.updateMountedGeometry;
    geometryWrites = vi
      .spyOn(mountedElements, "updateMountedGeometry")
      .mockImplementation((...args) => {
        original(...args);
        f.scheduler.time += 1;
      });
    f.renderer.applyDelta({ affected: sceneDeltaEntries(delta) });
    f.scheduler.runFrame();
    expect(penNode.attributes.get("d")).toBe(
      buildElementPathParts(
        strokeLocalGeometry(
          replacements[0]! as import("../../../../../src/domain/schema/public").StrokeElementV1,
        ),
      )[0]!.d,
    );
    expect(penNode.attributes.has("transform")).toBe(false);
    expect(fakeNode(f.renderer.svg).attributes.get("data-inkbook-run-feedback")).toBe("true");
    f.scheduler.runAll();
    const svg = fakeNode(f.renderer.svg);
    expect(svg.attributes.has("data-inkbook-run-feedback")).toBe(false);
    expect(svg.attributes.get("data-inkbook-run-ready")).toBe("true");
    for (const e of replacements) expect(f.store.get(e.id)?.element).toEqual(e);
    expectCanonical(f);
    expect(contentPaths(svg).every((node) => !node.attributes.has("transform"))).toBe(true);
    const traces = svg.nodes[1]!.nodes[8]!;
    const tracePaths = (node: typeof svg): (typeof svg)[] =>
      node.tagName === "path" ? [node] : node.nodes.flatMap(tracePaths);
    const liveTraces = tracePaths(traces);
    expect(liveTraces).toHaveLength(f.ids.length);
    expect(
      new Set(liveTraces.map((node) => node.attributes.get("data-selection-element-id"))),
    ).toEqual(new Set(f.ids));
    expect(liveTraces.every((node) => !node.attributes.has("transform"))).toBe(true);
    for (const pen of f.pens)
      expect(
        liveTraces.find((node) => node.attributes.get("data-selection-element-id") === pen)?.parent,
      ).toBe(traces);
  } finally {
    geometryWrites?.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("reprepares a stale normalized shared cohort after move and rotation before the next scale", () => {
  const f = fixture();
  try {
    startSelectionResize(f);
    const scaled = commitSelectionScale(f, 2);
    f.scheduler.runAll();
    const svg = fakeNode(f.renderer.svg);
    expect(svg.attributes.get("data-inkbook-run-ready")).toBe("true");
    const moved = moveSelection(scaled, { x: 5, y: 3 });
    applySelectionDelta(f, moved);
    expect(svg.attributes.has("data-inkbook-run-ready")).toBe(false);
    f.scheduler.runAll();
    expect(svg.attributes.get("data-inkbook-run-ready")).toBe("true");
    const rotated = rotateSelection(moved, { x: 20, y: 20 }, 37);
    applySelectionDelta(f, rotated);
    expect(svg.attributes.has("data-inkbook-run-ready")).toBe(false);
    f.scheduler.runAll();
    expect(svg.attributes.get("data-inkbook-run-ready")).toBe("true");
    const materialize = (id: string) => {
      const e = rotated.find((e) => e.id === id);
      return e === undefined ? undefined : scaleElement(e, { x: 0, y: 0 }, { x: 2, y: 1 });
    };
    f.renderer.setProgressiveElementPreviews(f.ids, materialize, 2, f.feedback);
    f.renderer.flushPointerFeedbackFrame(0);
    expect(svg.attributes.get("data-inkbook-run-feedback")).toBe("true");
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("completes the 502-element fallback decision without preparing SVG runs and resets it on a new selection", () => {
  const f = fixture(500);
  try {
    const svg = fakeNode(f.renderer.svg);
    expect(svg.attributes.get("data-inkbook-run-fallback")).toBe("true");
    expect(svg.attributes.has("data-inkbook-run-ready")).toBe(false);
    f.renderer.resetInstrumentation();
    f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 1, f.feedback);
    f.renderer.flushPointerFeedbackFrame(0);
    expect(svg.attributes.has("data-inkbook-run-feedback")).toBe(false);
    expect(f.renderer.instrumentation().domReorders).toBe(0);
    expect(f.renderer.instrumentation().domRootsPublished).toBe(0);
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    f.renderer.setSelectedElements(new Set(f.ids));
    expect(svg.attributes.has("data-inkbook-run-fallback")).toBe(false);
    f.scheduler.runAll();
    expect(svg.attributes.get("data-inkbook-run-fallback")).toBe("true");
    const moved = moveSelection(f.selected, { x: 2, y: 0 });
    applySelectionDelta(f, moved);
    expect(svg.attributes.has("data-inkbook-run-fallback")).toBe(false);
    f.scheduler.runAll();
    expect(svg.attributes.get("data-inkbook-run-fallback")).toBe("true");
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it.each([false, true])(
  "keeps immediate second resize feedback visible before the prior canonical drain finishes (firstFrame=%s)",
  (firstFrame) => {
    const f = fixture();
    let geometry:
      import("vitest").MockInstance<typeof mountedElements.updateMountedGeometry> | undefined;
    try {
      startSelectionResize(f);
      const original = f.selected[f.selected.length - 1]!,
        originalD = buildElementPathParts(original)[0]!.d;
      const node = contentPaths(fakeNode(f.renderer.svg)).find(
        (path) => path.getAttribute("d") === originalD,
      )!;
      expect(node).toBeDefined();
      const first = f.selected.map((e) => scaleElement(e, { x: 0, y: 0 }, { x: 2, y: 1 }));
      armSelectionCommit(f);
      const update = mountedElements.updateMountedGeometry;
      geometry = vi
        .spyOn(mountedElements, "updateMountedGeometry")
        .mockImplementation((...args) => {
          update(...args);
          f.scheduler.time += 1;
        });
      f.renderer.applyDelta({
        affected: sceneDeltaEntries(f.store.replaceMany(first)!),
      });
      if (firstFrame) f.scheduler.runFrame();
      expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-feedback")).toBe("true");
      const latest = first.map((e) => scaleElement(e, { x: 0, y: 0 }, { x: 3, y: 1 })),
        byId = new Map(latest.map((e) => [e.id, e]));
      f.renderer.setProgressiveElementPreviews(f.ids, (id) => byId.get(id), 2, {
        ...f.feedback,
        transform: "scale(3 1)",
        inverse: "scale(0.3333333333333333 1)",
        matrix: [3, 0, 0, 1, 0, 0] as const,
      });
      f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
      const firstX = (d: string) => Number(/^M\s*([-\d.]+)/.exec(d)![1]);
      let actualX = firstX(node.getAttribute("d")!);
      const band = fakeNode(f.renderer.svg).nodes[1]!.nodes[4]!;
      for (
        let current: typeof node | undefined = node;
        current !== band;
        current = current?.parent
      ) {
        expect(current).toBeDefined();
        for (const m of (current!.getAttribute("transform") ?? "").matchAll(
          /scale\(([-\d.]+)(?:\s+[-\d.]+)?\)/g,
        ))
          actualX *= Number(m[1]);
      }
      const expectedX = firstX(buildElementPathParts(latest[latest.length - 1]!)[0]!.d);
      expect(actualX).toBeCloseTo(expectedX, 6);
      armSelectionCommit(f);
      f.renderer.applyDelta({
        affected: sceneDeltaEntries(f.store.replaceMany(latest)!),
      });
      f.scheduler.runAll(1000);
      const expected = latest.flatMap((e) =>
        buildElementPathParts(e.kind === "stroke" ? strokeLocalGeometry(e) : e).map(
          (part) => part.d,
        ),
      );
      const live = contentPaths(fakeNode(f.renderer.svg)).map((path) => path.getAttribute("d"));
      for (const d of expected) expect(live).toContain(d);
    } finally {
      geometry?.mockRestore();
      f.renderer.destroy();
      f.port.release();
    }
  },
);

it("cleans only physically prepared members when an equivalent selection Set replaces a partially prepared cohort", () => {
  const f = fixture(600, false, false);
  let move:
    import("vitest").MockInstance<typeof mountedElements.appendElementToFragment> | undefined;
  try {
    const original = mountedElements.appendElementToFragment;
    move = vi.spyOn(mountedElements, "appendElementToFragment").mockImplementation((...args) => {
      original(...args);
      f.scheduler.time += 3;
    });
    f.renderer.setSelectedElements(f.selection);
    for (let frame = 0; move.mock.calls.length === 0 && frame < 10; frame++) {
      f.scheduler.time += 1000 / 120;
      f.scheduler.runFrame();
    }
    expect(move.mock.calls.length).toBeGreaterThan(0);
    expect(move.mock.calls.length).toBeLessThan(600);
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-ready")).toBeNull();
    const selection = new Set(f.ids);
    f.renderer.setSelectedElements(selection);
    move.mockRestore();
    move = undefined;
    expect(() => f.scheduler.runAll(1000)).not.toThrow();
    const svg = fakeNode(f.renderer.svg);
    expect(svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    expect(contentPaths(svg)).toHaveLength(f.elements.length);
    f.renderer.setProgressiveElementPreviews(f.ids, f.materialize, 1, {
      ...f.feedback,
      selection,
    });
    f.renderer.flushPointerFeedbackFrame(0);
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
  } finally {
    move?.mockRestore();
    f.renderer.destroy();
    f.port.release();
  }
});

it("keeps shared parent payloads and group counts bounded across coalesced same-selection commits before the first scene frame", () => {
  const f = fixture();
  try {
    startSelectionResize(f);
    let latest = f.selected.map((e) => scaleElement(e, { x: 0, y: 0 }, { x: 2, y: 1 }));
    armSelectionCommit(f);
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany(latest)!),
    });
    const svg = fakeNode(f.renderer.svg),
      band = svg.nodes[1]!.nodes[4]!,
      groups = band.nodes.filter((node) => node.tagName === "g");
    expect(groups).toHaveLength(2);
    for (let generation = 2; generation <= 18; generation++) {
      latest = latest.map((e) => scaleElement(e, { x: 0, y: 0 }, { x: 1.01, y: 1 }));
      const values = new Map(latest.map((e) => [e.id, e]));
      f.renderer.setProgressiveElementPreviews(f.ids, (id) => values.get(id), generation, {
        ...f.feedback,
        transform: "scale(1.01 1)",
        inverse: `scale(${1 / 1.01} 1)`,
        matrix: [1.01, 0, 0, 1, 0, 0] as const,
      });
      f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
      f.renderer.resetInstrumentation();
      armSelectionCommit(f);
      f.renderer.applyDelta({
        affected: sceneDeltaEntries(f.store.replaceMany(latest)!),
      });
      expect(f.renderer.instrumentation().domReorders).toBe(0);
      expect(f.renderer.instrumentation().domRootsPublished).toBe(0);
      expect(band.nodes.filter((node) => node.tagName === "g")).toEqual(groups);
      // Six finite serialized coefficients plus the one original SVG scale expression.
      for (const group of groups)
        expect((group.getAttribute("transform") ?? "").length).toBeLessThan(256);
    }
    f.scheduler.runAll(1000);
    for (const e of latest) {
      const expected = buildElementPathParts(e.kind === "stroke" ? strokeLocalGeometry(e) : e).map(
        (part) => part.d,
      );
      for (const d of expected)
        expect(contentPaths(svg).some((path) => path.getAttribute("d") === d)).toBe(true);
    }
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});
