import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import { StoreOrderCursor } from "../../../../../src/domain/store/mutations/order-cursor";
import { indexedStroke } from "../../../../fixtures/editor/stroke";

it("reads current highlight/content order without snapshot allocation and releases its cursor", () => {
  const content = indexedStroke(0);
  const highlighter = indexedStroke(1);
  const highlight = {
    ...highlighter,
    tool: "highlighter" as const,
    style: { ...highlighter.style, pressureEnabled: false },
  };
  const store = new ElementStore([content, highlight]);
  const cursor = store.beginOrder();
  expect(cursor.memoryUsage()).toBe(128);
  expect(cursor.advance()).toEqual({ id: highlight.id, done: false, stale: false });
  expect(cursor.advance()).toEqual({ id: content.id, done: false, stale: false });
  expect(cursor.advance()).toEqual({ done: true, stale: false });
  expect(store.instrumentation.bandScans).toBe(0);
  expect(store.instrumentation.snapshotMaterializations).toBe(0);
  cursor.cancel();
  expect(cursor.memoryUsage()).toBe(0);
  expect(cursor.advance()).toEqual({ done: true, stale: true });
});

it("rejects order progress after an authoritative model mutation", () => {
  const element = indexedStroke(0);
  const store = new ElementStore([element]);
  const cursor = store.beginOrder();
  store.remove([element.id]);
  expect(cursor.advance()).toEqual({ done: true, stale: true });
  expect(store.beginOrder().advance()).toEqual({ done: true, stale: false });
});

it("reads authoritative bands lazily and checks the version before accessing replaced arrays", () => {
  let version = 0;
  let bands = { highlight: ["highlight"], content: ["content"] };
  const readBands = vi.fn(() => bands);
  const cursor = new StoreOrderCursor(readBands, () => version);
  expect(readBands).not.toHaveBeenCalled();
  expect(cursor.advance().id).toBe("highlight");
  expect(readBands).toHaveBeenCalledOnce();
  bands = { highlight: [], content: [] };
  version += 1;
  expect(cursor.advance()).toEqual({ done: true, stale: true });
  expect(readBands).toHaveBeenCalledOnce();
  cursor.cancel();
  expect(cursor.memoryUsage()).toBe(0);
});
