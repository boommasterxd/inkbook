import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import type { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { FakeSceneStore, fakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { PAGE } from "../../../unit/domain/store/fixtures";

describe("scene ordering without survivor rank deltas", () => {
  it("retains survivor nodes and resolves fresh order for insertion and remount", () => {
    const store = new FakeSceneStore();
    for (const [rank, id] of ["removed", "first", "last"].entries()) {
      store.records.set(id, fakeRectangleRecord(id, rank, 10 + rank * 20));
    }
    const { renderer, scheduler } = createSceneFixture(PAGE, store, {
      height: 100,
      left: 0,
      top: 0,
      width: 100,
    });
    renderer.setReducedMotion(true);
    scheduler.runAll();
    const group = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
    const survivors = group.nodes.slice(1);
    renderer.resetInstrumentation();

    store.records.delete("removed");
    store.records.set("first", { ...store.records.get("first")!, rank: 0 });
    store.records.set("last", { ...store.records.get("last")!, rank: 1 });
    renderer.applyDelta({ affected: [{ domains: ["visibility"], id: "removed" }] });
    scheduler.runAll();

    expect(renderer.mountedIds("content")).toEqual(["first", "last"]);
    expect(group.nodes[0]).toBe(survivors[0]);
    expect(group.nodes[1]).toBe(survivors[1]);
    expect(renderer.instrumentation()).toMatchObject({ domReorders: 0, geometryBuilds: 0 });

    store.records.set("last", { ...store.records.get("last")!, rank: 2 });
    store.records.set("inserted", fakeRectangleRecord("inserted", 1, 80));
    renderer.applyDelta({ affected: [{ domains: ["visibility"], id: "inserted" }] });
    scheduler.runAll();

    const expected = ["first", "inserted", "last"];
    expectSceneOrder(renderer, store, expected);
    expect(group.nodes[0]).toBe(survivors[0]);
    expect(group.nodes[2]).toBe(survivors[1]);
    expect(renderer.instrumentation()).toMatchObject({ domReorders: 0, geometryBuilds: 1 });

    renderer.setViewport({ height: 100, left: 0, top: 10_000, width: 100 });
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(0);
    renderer.setViewport({ height: 100, left: 0, top: 0, width: 100 });
    scheduler.runAll();
    expectSceneOrder(renderer, store, expected);
    renderer.destroy();
  });
});

function expectSceneOrder(
  renderer: SvgSceneRenderer,
  store: FakeSceneStore,
  expected: readonly string[],
): void {
  const group = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  expect(renderer.mountedIds("content")).toEqual(expected);
  expect(group.nodes.map((node) => node.attributes.get("d"))).toEqual(
    expected.map((id) => buildElementPathParts(store.records.get(id)!.element)[0]!.d),
  );
}
