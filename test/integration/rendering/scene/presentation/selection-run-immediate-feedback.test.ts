import { FakeNode, fakeNode, sceneBandNode } from "../../../../unit/rendering/scene/fakes";
import { afterEach, expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import {
  moveSelection,
  scaleElement,
} from "../../../../../src/editor/selection/transform/transforms";
import * as mountedElements from "../../../../../src/rendering/scene/content/mounted-element";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { draining } from "../../../../fixtures/rendering/selection-run-drain";
import { imageElement, imageResource } from "../../../../fixtures/domain/images";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { rectangle } from "../../../../unit/domain/store/fixtures";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  contentPaths,
  fixture,
  paintedX,
  moveFeedback,
  scaleFeedback,
  startSelectionResize,
  applySelectionDelta,
  armSelectionCommit,
  selectionPath,
  publishSelectionMove,
  expectCancelledSelectionMove,
} from "../../../../fixtures/rendering/selection-runs";

afterEach(() => vi.restoreAllMocks());

function target(f: ReturnType<typeof fixture>) {
  const last = f.selected[f.selected.length - 1]!;
  const svg = fakeNode(f.renderer.svg);
  const node = contentPaths(svg).find(
    (path) => path.getAttribute("d") === buildElementPathParts(last)[0]!.d,
  )!;
  expect(node).toBeDefined();
  return { last, node, band: sceneBandNode(svg, "content") };
}

function publishedCommitIds(f: ReturnType<typeof fixture>, originals: readonly InkElementV1[]) {
  const svg = fakeNode(f.renderer.svg);
  const paths = contentPaths(svg);
  const checked: string[] = [];
  for (const original of originals) {
    const moved = f.store.get(original.id)!.element as InkElementV1;
    const d = buildElementPathParts(original.kind === "stroke" ? original : moved)[0]!.d;
    const path = paths.find((node) => node.getAttribute("d") === d);
    if (
      path === undefined ||
      (moved.kind === "stroke" &&
        path.getAttribute("transform") !== `translate(${moved.offset!.x} ${moved.offset!.y})`)
    )
      continue;
    checked.push(original.id);
  }
  return checked;
}

it("finishes pending group admission while an immediate translation remains visible", () => {
  const f = fixture(600, false, false);
  try {
    const svg = fakeNode(f.renderer.svg);
    const { node, band } = target(f);
    const before = paintedX(node, band);
    f.renderer.setSelectedElements(f.selection);
    expect(svg.getAttribute("data-inkbook-run-ready")).toBeNull();
    publishSelectionMove(f, { x: 25, y: 10 });
    expect(paintedX(node, band)).toBeCloseTo(before + 25, 6);
    f.scheduler.runAll(1000);
    expect(paintedX(node, band)).toBeCloseTo(before + 25, 6);
    expect(svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    publishSelectionMove(f, { x: 50, y: 15 }, 2);
    expect(paintedX(node, band)).toBeCloseTo(before + 50, 6);
    expectCancelledSelectionMove(f, node, band, before);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("finishes a cancelled legacy-basis drain across selection change and offscreen reentry", () => {
  const f = fixture(600, false, false);
  try {
    const { last, node, band } = target(f);
    const before = paintedX(node, band);
    f.renderer.setSelectedElements(f.selection);
    publishSelectionMove(f, { x: 15, y: 10 });
    f.scheduler.runAll();
    publishSelectionMove(f, { x: 45, y: 15 }, 2);
    const original = mountedElements.updateMountedGeometry;
    vi.spyOn(mountedElements, "updateMountedGeometry").mockImplementation((...args) => {
      original(...args);
      f.scheduler.time += 1;
    });
    f.renderer.clearPreviewTransforms();
    expect(paintedX(node, band)).toBeCloseTo(before, 6);
    f.scheduler.runFrame();
    expect(paintedX(node, band)).toBeCloseTo(before, 6);
    f.renderer.setSelectedElements(new Set([last.id]));
    f.renderer.setCamera({ x: -10_000, zoom: 1 });
    f.scheduler.runAll(1000);
    f.renderer.setCamera({ x: 0, zoom: 1 });
    f.scheduler.runAll(1000);
    const reentered = selectionPath(f, last);
    expect(paintedX(reentered, sceneBandNode(fakeNode(f.renderer.svg), "content"))).toBeCloseTo(
      before,
      6,
    );
    expect(reentered.getAttribute("transform")).toBeNull();
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-feedback")).toBeNull();
    expect(f.selected.map((element) => f.store.get(element.id)?.element)).toEqual(f.selected);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("commits a later translation through the adopted legacy basis and restores it on undo", () => {
  const source = indexedStroke(80000);
  const stroke = {
    ...source,
    points: [80, 60, 0.5, 90, 60, 0.5],
    pivot: { x: 85, y: 60 },
    style: { ...source.style, pressureEnabled: false },
  };
  const box = rectangle(indexedStroke(80001).id, 80, 80);
  box.style = {
    ...box.style,
    outlineColor: { type: "rgba" as const, value: "#000000FF" as const },
  };
  const f = fixture(600, false, false, [imageElement(), stroke, box], 8, {
    imageResource: () => imageResource(),
  });
  f.selected.push(stroke, box);
  for (const element of [stroke, box]) {
    f.ids.push(element.id);
    f.selection.add(element.id);
  }
  try {
    const { node, band } = target(f);
    const before = paintedX(node, band);
    f.renderer.setSelectedElements(f.selection);
    const move = (x: number, version: number) => {
      f.renderer.setPreviewTransform(
        f.ids,
        `translate(${x} 10)`,
        version,
        "scale",
        undefined,
        moveFeedback(f.selection, x, 10),
      );
      f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    };
    move(15, 1);
    f.scheduler.runAll();
    expect(node.getAttribute("transform")).toBe("translate(15 10)");
    move(45, 2);
    expect(paintedX(node, band)).toBeCloseTo(before + 45, 6);
    armSelectionCommit(f);
    const original = mountedElements.updateMountedGeometry;
    vi.spyOn(mountedElements, "updateMountedGeometry").mockImplementation((...args) => {
      original(...args);
      f.scheduler.time += 1;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forwarded with the original DOM receiver.
    const write = FakeNode.prototype.setAttribute;
    vi.spyOn(FakeNode.prototype, "setAttribute").mockImplementation(function (
      this: FakeNode,
      name,
      value,
    ) {
      write.call(this, name, value);
      f.scheduler.time += 1;
    });
    const replacements = moveSelection(f.selected, { x: 45, y: 10 });
    f.renderer.applyDelta({ affected: sceneDeltaEntries(f.store.replaceMany(replacements)!) });
    f.renderer.clearPreviewTransforms();
    f.scheduler.runFrame();
    expect(paintedX(node, band)).toBeCloseTo(before + 45, 6);
    const svg = fakeNode(f.renderer.svg);
    const checked = new Set<string>();
    for (
      let frames = 0;
      frames < 1000 && svg.getAttribute("data-inkbook-run-feedback") !== null;
      frames += 1
    ) {
      f.scheduler.runFrame();
      for (const id of publishedCommitIds(f, [stroke, box])) checked.add(id);
    }
    expect(svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    expect(f.scheduler.pendingCount).toBeGreaterThan(0);
    expect(f.store.get(stroke.id)?.element).toMatchObject({ offset: { x: 45, y: 10 } });
    expect(checked).toEqual(new Set([stroke.id, box.id]));
    f.scheduler.runAll(1000);
    expect(paintedX(node, band)).toBeCloseTo(before + 45, 6);
    expect(f.selected.map((element) => f.store.get(element.id)?.element)).toEqual(replacements);
    applySelectionDelta(f, f.selected);
    f.scheduler.runAll(1000);
    expect(paintedX(node, band)).toBeCloseTo(before, 6);
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-feedback")).toBeNull();
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

it("reuses admission after an immediate move of a larger overlapping selection", () => {
  const f = fixture();
  try {
    const { node, band } = target(f);
    const before = paintedX(node, band);
    const ids = f.elements
      .filter((element) => element.kind === "rectangle")
      .map((element) => element.id);
    f.renderer.setSelectedElements(new Set(ids.slice(0, 550)));
    f.scheduler.runAll();
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-ready")).toBe("true");
    const selection = new Set(ids);
    f.renderer.setSelectedElements(selection);
    publishSelectionMove(f, { x: 30, y: 10 }, 1, { ids, selection });
    expect(paintedX(node, band)).toBeCloseTo(before + 30, 6);
    f.scheduler.runAll(1000);
    expect(paintedX(node, band)).toBeCloseTo(before + 30, 6);
    expect(fakeNode(f.renderer.svg).getAttribute("data-inkbook-run-ready")).toBe("true");
    expectCancelledSelectionMove(f, node, band, before);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});

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
  const f = fixture(600, false, false, [{ ...imageElement(), locked: true }], 8, {
    imageResource: () => imageResource(),
  });
  try {
    const selected: InkElementV1[] = f.selected;
    const last = selected[selected.length - 1]!;
    if (last.kind !== "rectangle") throw new Error("Expected a rectangle target.");
    const fixed = {
      ...last,
      style: {
        ...last.style,
        outlineColor: { type: "rgba" as const, value: "#000000FF" as const },
      },
    };
    selected[selected.length - 1] = fixed;
    f.renderer.applyDelta({ affected: sceneDeltaEntries(f.store.replaceMany([fixed])!) });
    f.scheduler.runAll(1000);
    f.renderer.setSelectedElements(f.selection);
    publishSelectionMove(f, { x: 25, y: 5 });
    const replacements = moveSelection(selected, { x: 25, y: 5 });
    armSelectionCommit(f);
    f.renderer.applyDelta({ affected: sceneDeltaEntries(f.store.replaceMany(replacements)!) });
    f.renderer.clearPreviewTransforms();
    f.scheduler.runAll(1000);
    selected.splice(0, selected.length, ...replacements);
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
    f.scheduler.runAll(1000);
    expect(paintedX(node, band)).toBe(0);
    expect(node.getAttribute("transform")).not.toMatch(/NaN|Infinity/);
    f.renderer.setProgressiveElementPreviews(
      f.ids,
      f.materialize,
      3,
      scaleFeedback(f.selection, 2),
    );
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    f.scheduler.runAll(1000);
  } finally {
    f.renderer.destroy();
    f.port.release();
  }
});
