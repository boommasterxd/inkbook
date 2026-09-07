import { describe, expect, it } from "vitest";

import {
  calculateElementBounds,
  buildElementPathParts,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { createAllElementSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { FakeSceneStore, fakeNode } from "../../../unit/rendering/scene/fakes";

function setup() {
  const snapshot = createAllElementSnapshot();
  const elements = snapshot.elements.filter(
    (element) =>
      element.kind === "stroke" || element.kind === "arrow" || element.kind === "coordinate-system",
  );
  const pressure = elements.find((element) => element.kind === "stroke")!;
  if (pressure.kind === "stroke")
    pressure.points = Array.from({ length: 4096 }, (_, index) => [
      100 + index * 0.1,
      250 + (index % 2),
      (index % 10) / 10,
    ]).flat();
  const store = new FakeSceneStore();
  for (const [rank, element] of elements.entries())
    store.records.set(element.id, {
      element,
      rank,
      id: element.id,
      band: "content",
      bounds: calculateElementBounds(element),
      geometryVersion: 1,
      paintVersion: 1,
    });
  const { renderer, scheduler } = createSceneFixture(snapshot.page, store);
  scheduler.runAll();
  const content = fakeNode(renderer.svg).nodes[1]!.nodes[4]!;
  return { renderer, scheduler, elements, content };
}

function shifted(element: InkElementV1): InkElementV1 {
  if (element.kind === "stroke")
    return {
      ...element,
      points: element.points.map((value, index) => (index % 3 === 0 ? value * 2 : value)),
    };
  if (element.kind === "arrow")
    return { ...element, end: { ...element.end, x: element.end.x + 100 } };
  if (element.kind === "coordinate-system")
    return { ...element, origin: { ...element.origin, x: element.origin.x + 10 } };
  return element;
}

describe("progressive selection canonical scene parity", () => {
  it("keeps complete canonical pressure and arrow geometry through asynchronous resize and cancellation", () => {
    const { renderer, scheduler, elements, content } = setup();
    const original = content.nodes.map((node) => new Map(node.attributes));
    const replacements = elements.map(shifted);
    const originalMemory = renderer.memoryUsage().pathCacheBytes;
    renderer.setProgressiveElementPreviews(
      elements.map(({ id }) => id),
      (id) => replacements.find((element) => element.id === id),
      1,
    );
    // An incomplete pressure sweep must retain the existing complete path.
    scheduler.runNext();
    expect(content.nodes[0]!.attributes.get("d")).toBe(original[0]!.get("d"));
    scheduler.runAll();
    expect(content.nodes.map((node) => node.attributes.get("d"))).toEqual(
      replacements.flatMap(buildElementPathParts).map(({ d }) => d),
    );
    expect(content.nodes.every((node) => !node.attributes.has("transform"))).toBe(true);
    expect(renderer.memoryUsage().pathCacheBytes).toBeGreaterThan(originalMemory);
    renderer.clearElementPreviews();
    scheduler.runAll();
    expect(content.nodes.map((node) => node.attributes)).toEqual(original);
    expect(renderer.memoryUsage().pathCacheBytes).toBe(originalMemory);
    renderer.destroy();
  });

  it("cancels pending canonical work before a cleared selection can reappear", () => {
    const { renderer, scheduler, elements, content } = setup();
    const original = content.nodes.map((node) => new Map(node.attributes));
    renderer.setProgressiveElementPreviews(
      elements.map(({ id }) => id),
      (id) => elements.find((element) => element.id === id),
      1,
    );
    scheduler.runNext();
    renderer.clearProgressiveElementPreviews();
    scheduler.runAll();
    expect(content.nodes.map((node) => node.attributes)).toEqual(original);
    renderer.destroy();
  });
});
