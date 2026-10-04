import { expect, it, vi } from "vitest";
import { ConnectedRootOrder } from "../../../../src/rendering/scene/connected-root-order";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import type { MountedSceneElement } from "../../../../src/rendering/scene/mounted-element";
import type { SceneElementRecord } from "../../../../src/rendering/scene/types";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import { asDocument, FakeDocument, FakeSceneStore, fakeRectangleRecord } from "./fakes";

function observeIndexMoves() {
  let maximumRootSlots = 0;
  let maximumBlockSlots = 0;
  const original = Array.prototype.splice;
  const splice = vi.spyOn(Array.prototype, "splice").mockImplementation(function (
    this: unknown[],
    ...args: [number, number?, ...unknown[]]
  ) {
    const first = this[0] as { id?: string; entries?: unknown[] } | undefined;
    if (first?.id !== undefined) maximumRootSlots = Math.max(maximumRootSlots, this.length);
    else if (first?.entries !== undefined)
      maximumBlockSlots = Math.max(maximumBlockSlots, this.length);
    return Reflect.apply(original, this, args) as unknown[];
  });
  return {
    finish: () => {
      splice.mockRestore();
      return { maximumRootSlots, maximumBlockSlots };
    },
  };
}

it("maintains interleaved band successors through insertion, rank shifts, removal, and reuse", () => {
  const order = new ConnectedRootOrder();
  const store = new FakeSceneStore();
  const document = asDocument(new FakeDocument());
  const instrumentation = createInstrumentation();
  const entries = Array.from({ length: 1_000 }, (_, rank) => {
    const record = {
      ...fakeRectangleRecord(`order-${rank}`, rank, 10),
      band: rank % 2 === 0 ? ("content" as const) : ("highlight" as const),
    };
    store.records.set(record.id, record);
    return createMountedElement(
      document,
      record,
      buildElementPathParts(record.element),
      instrumentation,
    );
  });
  const mutations = observeIndexMoves();
  for (const entry of entries.slice().reverse()) order.add(entry, store);
  const moves = mutations.finish();
  expect(moves.maximumRootSlots).toBeLessThanOrEqual(129);
  expect(moves.maximumBlockSlots).toBeLessThanOrEqual(2 * Math.ceil(entries.length / 64));
  const get = vi.spyOn(store, "get");
  const comparisons = vi.spyOn(
    order as unknown as {
      earlier(entry: MountedSceneElement, record: Pick<SceneElementRecord, "id" | "rank">): boolean;
    },
    "earlier",
  );
  for (const entry of entries) {
    comparisons.mockClear();
    expect(order.successor(entry)).toBe(entries[entry.rank + 2]);
    expect(comparisons.mock.calls.length).toBeLessThanOrEqual(20);
  }
  expect(get).not.toHaveBeenCalled();
  for (const record of store.records.values())
    store.records.set(record.id, { ...record, rank: record.rank + 20 });
  order.invalidateRanks();
  for (const entry of entries)
    expect(order.successor({ ...entry, rank: entry.rank + 20 })).toBe(entries[entry.rank + 2]);
  expect(get.mock.calls.length).toBeLessThanOrEqual(entries.length);
  get.mockClear();
  for (const entry of entries) order.successor({ ...entry, rank: entry.rank + 20 });
  expect(get).not.toHaveBeenCalled();
  for (const entry of entries.slice(0, 500)) order.remove(entry.id);
  expect(order.successor({ id: "removed", rank: 19, band: "content" })).toBe(entries[500]);
  order.remove("unknown");
  order.clear();
  expect(order.memoryUsage()).toBe(0);
  expect(order.successor(entries[999]!)).toBeUndefined();
  order.add(entries[1]!);
  expect(order.successor({ id: "earlier", rank: 0, band: "highlight" })).toBe(entries[1]);
});
