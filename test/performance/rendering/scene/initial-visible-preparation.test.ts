import { expect, it } from "vitest";
import { createSceneFixture, createSceneRecord } from "../../../fixtures/rendering/scene";
import { NAVIGATION_PAGE } from "../../../fixtures/rendering/pressure-navigation";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { FakeSceneStore } from "../../../unit/rendering/scene/fakes";

function initialVisibleFixture() {
  const store = new FakeSceneStore();
  const reads = new Map<string, number>();
  const visible = { content: [] as string[], highlight: [] as string[] };
  for (let rank = 0; rank < 10_000; rank += 1) {
    const y = rank < 160 ? (rank === 159 ? 95 : 20) : rank < 800 ? 140 : 10_000;
    const element = {
      ...indexedStroke(rank),
      pivot: { x: 20, y },
      tool: rank % 2 === 0 ? ("highlighter" as const) : ("pen" as const),
      points: Array.from({ length: 24 }, (_, sample) => [20 + sample, y + sample / 2, 0.5]).flat(),
    };
    const record = createSceneRecord(element, rank);
    const points = new Proxy(element.points, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key))
          reads.set(element.id, (reads.get(element.id) ?? 0) + 1);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    store.records.set(element.id, { ...record, element: { ...element, points } });
    if (rank < 160) visible[record.band].push(record.id);
  }
  return { store, reads, visible };
}

it("prepares and publishes the complete exact viewport before reading any overscan points", () => {
  const fixture = initialVisibleFixture();
  const { renderer, scheduler } = createSceneFixture(
    NAVIGATION_PAGE,
    fixture.store,
    { height: 100, left: 0, top: 0, width: 100 },
    { deferInitialOverscan: true },
  );
  let previous = 0;
  while (scheduler.pendingCount > 0) {
    scheduler.runNext();
    expect(renderer.mountedCount - previous).toBeLessThanOrEqual(64);
    previous = renderer.mountedCount;
    if (renderer.mountedCount < 160) expect(renderer.sceneCommitProof).toBeUndefined();
  }
  expect(renderer.mountedIds("highlight")).toEqual(fixture.visible.highlight);
  expect(renderer.mountedIds("content")).toEqual(fixture.visible.content);
  expect(renderer.sceneCommitProof).toBeDefined();
  expect(renderer.instrumentation()).toMatchObject({ geometryBuilds: 160, backgroundBuilds: 1 });
  expect(fixture.reads.size).toBe(160);
  expect([...fixture.reads.values()].every((count) => count > 0 && count <= 288)).toBe(true);
  const visibleReads = new Map(fixture.reads);

  renderer.releaseInitialOverscan();
  previous = renderer.mountedCount;
  while (scheduler.pendingCount > 0) {
    scheduler.runNext();
    expect(renderer.mountedCount - previous).toBeLessThanOrEqual(64);
    previous = renderer.mountedCount;
  }
  expect(renderer.mountedCount).toBe(800);
  expect(fixture.reads.size).toBe(800);
  for (const [id, count] of visibleReads) expect(fixture.reads.get(id)).toBe(count);
  expect(renderer.instrumentation()).toMatchObject({ geometryBuilds: 800, backgroundBuilds: 1 });
  renderer.destroy();
  expect(renderer.mountedCount).toBe(0);
  expect(scheduler.pendingCount).toBe(0);
});
