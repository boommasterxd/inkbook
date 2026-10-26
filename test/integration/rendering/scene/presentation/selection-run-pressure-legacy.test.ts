import { expect, it } from "vitest";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  moveSelection,
  rotateSelection,
  scaleElement,
} from "../../../../../src/editor/selection/transform/transforms";
import * as mounted from "../../../../../src/rendering/scene/content/mounted-element";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { compoundPressureElements } from "../../../../fixtures/rendering/selection-pressure-runs";
import {
  applySelectionDelta,
  armSelectionCommit,
} from "../../../../fixtures/rendering/selection-runs";
import { fakeNode } from "../../../../unit/rendering/scene/fakes";

import {
  assertGeometry,
  fixture,
  matrixEqual,
  paths,
  start,
  world,
} from "../../../../fixtures/rendering/selection-pressure-runs";

it("keeps all original 10000 pressure pens on legacy feedback and moves their real ink and traces on the first pointer feedback", () => {
  const f = fixture(10000);
  try {
    expect(f.renderer.mountedIds("content")).toHaveLength(10000);
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    f.renderer.resetInstrumentation();
    start(f, 1.5);
    expect(f.svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    expect(f.renderer.instrumentation().domReorders).toBe(0);
    expect(f.renderer.instrumentation().domRootsPublished).toBe(0);
    const traceMap = new Map(
      paths(f.traces).map((n) => [n.getAttribute("data-selection-element-id"), n]),
    );
    for (const id of f.ids) {
      matrixEqual(world(fakeNode(f.entries.get(id)!.paths[0]!.node), f.ink), [1.5, 0, 0, 1, 0, 0]);
      matrixEqual(world(traceMap.get(id)!, f.traces), [1.5, 0, 0, 1, 0, 0]);
    }
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    assertGeometry(f, f.elements);
  } finally {
    f.dispose();
  }
}, 30000);

it("keeps pressure legacy ink and trace bases coherent through reversal, cancellation and a new gesture", () => {
  const f = fixture();
  try {
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    const initialMaterialize = start(f, 2);
    f.scheduler.runAll();
    const snapshotIds = new Set(initialMaterialize.mock.calls.map(([id]) => id));
    expect(snapshotIds.size).toBe(256);
    assertGeometry(
      f,
      f.elements.map((element) =>
        snapshotIds.has(element.id)
          ? scaleElement(element, { x: 0, y: 0 }, { x: 2, y: 1 })
          : element,
      ),
    );
    const materialize = start(f, 0.5, 2);
    const traceMap = new Map(
      paths(f.traces).map((n) => [n.getAttribute("data-selection-element-id"), n]),
    );
    for (const id of f.ids) {
      const expected = [snapshotIds.has(id) ? 0.25 : 0.5, 0, 0, 1, 0, 0] as const;
      matrixEqual(world(fakeNode(f.entries.get(id)!.paths[0]!.node), f.ink), expected);
      matrixEqual(world(traceMap.get(id)!, f.traces), expected);
    }
    expect(materialize).not.toHaveBeenCalled();
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    assertGeometry(f, f.elements);
    start(f, 1.25, 3);
    f.scheduler.runAll();
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    assertGeometry(f, f.elements);
  } finally {
    f.dispose();
  }
});

it("uses direct singular feedback and recovers pressure geometry after cancellation", () => {
  const f = fixture();
  try {
    start(f, 0);
    f.scheduler.runAll();
    expect(f.svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    assertGeometry(f, f.elements);
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    start(f, 1.5, 2);
    expect(f.svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
  } finally {
    f.dispose();
  }
});

it("normalizes pressure-dominant legacy commit with real table coordinate and filled-arrow topology", () => {
  const { table, coordinate, arrow } = compoundPressureElements(70000);
  const f = fixture(600, [table, coordinate, arrow]);
  try {
    start(f, 1.5, 1, 0.75);
    f.scheduler.runAll();
    armSelectionCommit(f);
    const replacements = f.elements.map((e) =>
      scaleElement(e, { x: 0, y: 0 }, { x: 1.5, y: 0.75 }),
    );
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany(replacements)!),
    });
    f.scheduler.runAll();
    assertGeometry(f, replacements);
    expect(f.svg.getAttribute("data-inkbook-run-feedback")).toBeNull();
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    const moved = moveSelection(replacements, { x: 4, y: 8 });
    const rotated = rotateSelection(moved, { x: 30, y: 30 }, 30);
    applySelectionDelta(f, rotated);
    f.scheduler.runAll();
    assertGeometry(f, rotated);
    expect(paths(f.traces)).toHaveLength(f.ids.length);
  } finally {
    f.dispose();
  }
});

it("replaces real arrow topology on the pressure legacy path and refreshes table and coordinate geometry", () => {
  const { table, coordinate, arrow } = compoundPressureElements(71000);
  const f = fixture(600, [table, coordinate, arrow]);
  try {
    const previous = f.entries.get(arrow.id)!.paths.map((p) => fakeNode(p.node));
    expect(previous.length).toBeGreaterThan(1);
    const updated: InkElementV1[] = [
      {
        ...table,
        columns: table.columns + 1,
        pivot: { x: table.pivot.x + table.columnWidth / 2, y: table.pivot.y },
      },
      {
        ...coordinate,
        dimension: "3d",
        axes: [
          { x: 60, y: 30 },
          { x: 30, y: 0 },
          { x: 5, y: 55 },
        ],
      },
      { ...arrow, startNode: "none", endNode: "none" },
    ];
    f.renderer.suppressMotionForNextDelta(updated.map((e) => e.id));
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany(updated)!),
    });
    f.scheduler.runAll();
    expect(f.entries.get(arrow.id)!.paths).toHaveLength(1);
    for (const node of previous) expect(node.parent).toBeUndefined();
    assertGeometry(f, updated);
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    for (const e of updated) f.elements[f.elements.findIndex((prior) => prior.id === e.id)] = e;
    start(f, 2);
    f.scheduler.runAll();
    f.renderer.clearProgressiveElementPreviews();
    f.scheduler.runAll();
    assertGeometry(f, updated);
  } finally {
    f.dispose();
  }
});

it("retains one translucent pressure paint root across multiple canonical preparation windows and commit", () => {
  const f = fixture(600, [], true);
  try {
    const id = f.ids[0]!,
      entry = f.entries.get(id)!,
      record = f.store.get(id)!;
    const geometry = f.store.pressureGeometry(id, record.geometryVersion);
    expect(geometry.readWindow(0)).toBeDefined();
    expect(geometry.readWindow(1)).toBeDefined();
    expect(entry.paths).toHaveLength(1);
    expect(fakeNode(mounted.firstPath(entry)).getAttribute("opacity")).toBe("0.4");
    expect(f.svg.getAttribute("data-inkbook-run-fallback")).toBe("true");
    start(f, 1.5);
    f.scheduler.runAll();
    armSelectionCommit(f);
    const replacements = f.elements.map((e) => scaleElement(e, { x: 0, y: 0 }, { x: 1.5, y: 1 }));
    f.renderer.applyDelta({
      affected: sceneDeltaEntries(f.store.replaceMany(replacements)!),
    });
    f.scheduler.runAll();
    assertGeometry(f, replacements);
    expect(entry.paths).toHaveLength(1);
    expect(fakeNode(mounted.firstPath(entry)).getAttribute("opacity")).toBe("0.4");
  } finally {
    f.dispose();
  }
});
