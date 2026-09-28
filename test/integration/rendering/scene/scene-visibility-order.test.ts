import { expect, it } from "vitest";

import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { FakeSceneStore, fakeNode, fakeRectangleRecord } from "../../../unit/rendering/scene/fakes";

it("merges viewport entrants into band order and sorts after a rank change", () => {
  const store = new FakeSceneStore();
  const first = fakeRectangleRecord("first", 10, 10);
  const last = fakeRectangleRecord("last", 30, 10);
  const entrant = fakeRectangleRecord("entrant", 20, 10, 190);
  const nextEntrant = fakeRectangleRecord("next-entrant", 15, 10, 260);
  for (const record of [first, last, entrant, nextEntrant]) store.records.set(record.id, record);
  const { renderer, scheduler } = createSceneFixture(NAVIGATION_PAGE, store, {
    height: 100,
    left: 0,
    top: 0,
    width: 100,
  });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["first", "last"]);
  const camera = fakeNode(renderer.svg).nodes[1]!;
  const highlightGroup = camera.nodes[3]!;
  const contentGroup = camera.nodes[4]!;
  const firstNode = contentGroup.nodes[0]!;

  store.records.set(first.id, { ...first, band: "highlight" });
  renderer.applyDelta({ affected: [{ id: first.id, domains: ["order", "visibility"] }] });
  renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["entrant", "last"]);
  expect(renderer.mountedIds("highlight")).toEqual(["first"]);
  expect(firstNode.parent).toBe(highlightGroup);

  store.records.set(last.id, { ...last, rank: 5 });
  renderer.resetInstrumentation();
  renderer.applyDelta({ affected: [{ id: last.id, domains: ["order"] }] });
  renderer.setViewport({ height: 100, left: 0, top: 100, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["last", "next-entrant", "entrant"]);
  expect(renderer.instrumentation().domReorders).toBeGreaterThan(0);

  store.records.set(first.id, { ...first, rank: 12 });
  renderer.applyDelta({ affected: [{ id: first.id, domains: ["order", "visibility"] }] });
  renderer.setViewport({ height: 100, left: 0, top: 50, width: 100 });
  scheduler.runAll();
  expect(renderer.mountedIds("content")).toEqual(["last", "first", "entrant"]);
  expect(renderer.mountedIds("highlight")).toEqual([]);
  expect(firstNode.parent).toBe(contentGroup);
  expect(contentGroup.nodes[1]).toBe(firstNode);
  renderer.destroy();
});
