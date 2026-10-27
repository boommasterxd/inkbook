import { afterEach, expect, it, vi } from "vitest";
import type { ArrowElementV1, InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  moveSelection,
  scaleElement,
} from "../../../../../src/editor/selection/transform/transforms";
import {
  assertCanonicalPath,
  assertFill,
  assertInvertibleParents,
  commit,
  points,
  pressure,
  rect,
  scale,
  world,
} from "../../../../fixtures/rendering/selection-run-world";
import { commitSelectionMove, moveFeedback } from "../../../../fixtures/rendering/selection-runs";
import { coordinateSystem } from "../../../../unit/domain/geometry/fixtures";

afterEach(() => vi.restoreAllMocks());

it("declines an over-capacity pressure cohort and completes canonical zero, positive and cancel paint without extra surfaces", () => {
  const originals = Array.from({ length: 600 }, (_, index) => pressure(index));
  const f = world(originals);
  try {
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    expect(f.svg.getAttribute("data-inkbook-run-ready")).toBeNull();
    const initialCreations = f.creations.mock.calls.length;
    const retained = f.visible(originals[0]!.id)[0]!;
    for (const [version, factor] of [0, 2, 0].entries()) {
      const changed = scale(f, factor, version + 1);
      // Legacy snapshots are capped at256 path costs. Full-cohort completion and
      // retained ownership below cover capacity without inventing a new budget.
      expect(new Set(f.materialized).size).toBe(256);
      for (const index of [0, 255]) assertFill(f, changed[index]!);
      expect(f.visible(originals[0]!.id)[0]).toBe(retained);
      expect(f.creations.mock.calls.length).toBe(initialCreations);
      expect(f.renderer.memoryUsage().pathCacheBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
      expect(f.svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    }
    f.renderer.clearPreviewTransforms();
    f.renderer.clearElementPreviews();
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    f.scheduler.runAll(1000);
    for (const index of [0, 255, 256, 599]) assertFill(f, originals[index]!);
    originals.forEach((element) => expect(f.store.get(element.id)!.element).toEqual(element));
  } finally {
    f.dispose();
  }
});

it("keeps unchanged anchor pressure painted across a zero commit and an immediate foreign move", () => {
  const anchor = pressure(0, 0),
    foreign = rect(900);
  const selected: InkElementV1[] = [
    anchor,
    ...Array.from({ length: 599 }, (_, index) => rect(index)),
  ];
  const f = world([...selected, foreign], selected, 1);
  try {
    const collapsed = scale(f, 0, 1);
    expect(f.materialized).toContain(anchor.id);
    assertFill(f, collapsed[0]!);
    const delta = commit(f, collapsed);
    expect(
      delta.changes.some((change) => change.id === anchor.id),
      "Vertical pressure exactly on scale anchor emits no committed geometry delta",
    ).toBe(false);
    // No renderer frame is permitted between adoption and the next gesture.
    assertFill(f, collapsed[0]!);
    const ids = [anchor.id, foreign.id],
      selection = new Set(ids);
    f.renderer.setSelectedElements(selection);
    f.renderer.setPreviewTransform(
      ids,
      "translate(10 0)",
      2,
      "scale",
      undefined,
      moveFeedback(selection, 10, 0),
    );
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    const moved = moveSelection(
      ids.map((id) => f.store.get(id)!.element as InkElementV1),
      { x: 10, y: 0 },
    );
    assertFill(f, moved[0]!);
    commitSelectionMove(f, ids, moved);
    f.scheduler.runAll(1000);
    assertFill(f, moved[0]!);
    expect(f.scheduler.pendingCount).toBe(0);
  } finally {
    f.dispose();
  }
});

it("declines grouped fixed arrowhead fills and preserves their canonical finite width at zero", () => {
  const arrows: ArrowElementV1[] = (["triangle", "diamond", "circle"] as const).map(
    (endNode, index) => ({
      id: rect(index + 900).id,
      createdAt: index,
      pivot: { x: 25, y: 40 },
      rotation: 0,
      style: {
        outlineColor: { type: "theme-text" },
        outlineOpacity: 1,
        outlineWidth: 2,
        outlineStyle: "solid",
      },
      kind: "arrow",
      start: { x: 10, y: 20 },
      end: { x: 40, y: 60 },
      bend: null,
      startNode: "none",
      endNode,
      startConnection: null,
      endConnection: null,
    }),
  );
  const elements: InkElementV1[] = [
    ...arrows,
    ...Array.from({ length: 597 }, (_, index) => rect(index)),
  ];
  const f = world(elements, elements, 3);
  try {
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    const collapsed = scale(f, 0, 1);
    for (const arrow of arrows) expect(f.materialized).toContain(arrow.id);
    for (const arrow of collapsed.slice(0, 3)) assertFill(f, arrow);
    const positive = scale(f, 2, 2);
    for (const arrow of positive.slice(0, 3)) assertFill(f, arrow);
    f.renderer.clearElementPreviews();
    f.renderer.clearPreviewTransforms();
    f.scheduler.runAll(1000);
    for (const arrow of arrows) assertFill(f, arrow);
  } finally {
    f.dispose();
  }
});

it("keeps physical parents invertible for safe grouped shapes at zero and recovers the next gesture", () => {
  const f = world(Array.from({ length: 600 }, (_, index) => rect(index)));
  try {
    expect(f.svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    scale(f, 0, 1);
    const target = f.selected[599]!;
    assertInvertibleParents(f.visible(target.id)[0]!, f.svg);
    const collapsed = f.visible(target.id)[0]!;
    expect(points(collapsed, f.svg).every((point) => point.x === 0)).toBe(true);
    commit(
      f,
      f.selected.map((element) => scaleElement(element, { x: 0, y: 0 }, { x: 0, y: 1 })),
    );
    const selection = new Set(f.ids);
    f.renderer.setSelectedElements(selection);
    f.renderer.setPreviewTransform(
      f.ids,
      "translate(10 0)",
      2,
      "scale",
      undefined,
      moveFeedback(selection, 10, 0),
    );
    f.renderer.flushPointerFeedbackFrame(f.scheduler.now());
    expect(points(f.visible(target.id)[0]!, f.svg).every((point) => point.x === 10)).toBe(true);
    assertInvertibleParents(f.visible(target.id)[0]!, f.svg);
    f.renderer.clearPreviewTransforms();
    f.scheduler.runAll(1000);
    expect(points(f.visible(target.id)[0]!, f.svg).every((point) => point.x === 0)).toBe(true);
  } finally {
    f.dispose();
  }
});

it("publishes canonical open arrowheads and compound coordinate axes in a safe zero-scale group", () => {
  const arrow: ArrowElementV1 = {
    id: rect(900).id,
    createdAt: 0,
    rotation: 0,
    pivot: { x: 25, y: 40 },
    kind: "arrow",
    start: { x: 10, y: 20 },
    end: { x: 40, y: 60 },
    bend: null,
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineWidth: 2,
      outlineStyle: "solid",
    },
    startNode: "arrow",
    endNode: "arrow",
    startConnection: null,
    endConnection: null,
  };
  const axes = coordinateSystem("3d");
  const elements: InkElementV1[] = [
    arrow,
    axes,
    ...Array.from({ length: 598 }, (_, index) => rect(index)),
  ];
  const f = world(elements, elements, 2);
  try {
    expect(f.svg.getAttribute("data-inkbook-run-ready")).toBe("true");
    const collapsed = scale(f, 0, 1);
    for (const element of collapsed.slice(0, 2)) {
      expect(f.materialized).toContain(element.id);
      assertCanonicalPath(f, element);
      for (const path of f.visible(element.id)) assertInvertibleParents(path, f.svg);
      const x = f
        .visible(element.id)
        .flatMap((path) => points(path, f.svg).map((point) => point.x));
      expect(
        Math.max(...x) - Math.min(...x),
        "Canonical endpoint heads retain transverse width after Sx0",
      ).toBeGreaterThan(0);
    }
    const positive = scale(f, 2, 2);
    for (const element of positive.slice(0, 2)) assertCanonicalPath(f, element);
    f.renderer.clearPreviewTransforms();
    f.renderer.clearElementPreviews();
    f.scheduler.runAll(1000);
    assertCanonicalPath(f, arrow);
    assertCanonicalPath(f, axes);
  } finally {
    f.dispose();
  }
});
