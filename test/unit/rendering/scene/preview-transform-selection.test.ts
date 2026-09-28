import { describe, expect, it } from "vitest";
import { ViewportPreviewSelection } from "../../../../src/rendering/scene/preview-transform-selection";
import { FakeSceneStore, fakeRectangleRecord } from "./fakes";

const viewport = { height: 100, left: 0, top: 0, width: 100 };
const camera = { x: 0, zoom: 1 };

describe("viewport preview selection", () => {
  it("keeps deterministic nearest candidates under dense capacity and filters unselected ids", () => {
    const store = new FakeSceneStore();
    const ids = Array.from({ length: 1000 }, (_, index) => String(index).padStart(4, "0"));
    for (const id of [...ids].reverse()) store.records.set(id, fakeRectangleRecord(id, 0, 30));
    store.records.set("unselected", fakeRectangleRecord("unselected", 0, 30));
    const selection = new ViewportPreviewSelection();
    expect(selection.select(ids, store, viewport, camera)).toEqual(ids.slice(0, 256));
    selection.clear();
    expect(selection.select([], store, viewport, camera)).toEqual([]);
  });

  it("counts filled arrow nodes and uses a later single-path candidate to fill the budget", () => {
    const store = new FakeSceneStore();
    const ids = Array.from({ length: 300 }, (_, index) => String(index).padStart(4, "0"));
    for (const id of ids) {
      const record = fakeRectangleRecord(id, 0, 30);
      store.records.set(id, {
        ...record,
        element: {
          id,
          kind: "arrow",
          createdAt: 0,
          rotation: 0,
          start: { x: 30, y: 10 },
          end: { x: 50, y: 30 },
          pivot: { x: 40, y: 20 },
          bend: null,
          startConnection: null,
          endConnection: null,
          startNode: "triangle",
          endNode: "circle",
          style: {
            outlineColor: { type: "rgba", value: "#112233FF" },
            outlineOpacity: 1,
            outlineStyle: "solid",
            outlineWidth: 2,
          },
        },
      });
    }
    store.records.set("last", fakeRectangleRecord("last", 0, 30));
    const selection = new ViewportPreviewSelection();
    expect(selection.select([...ids, "last"], store, viewport, camera)).toEqual([
      ...ids.slice(0, 85),
      "last",
    ]);
  });

  it("preserves small offscreen selections and ignores missing ids", () => {
    const store = new FakeSceneStore();
    store.records.set("far", fakeRectangleRecord("far", 0, 10000));
    const selection = new ViewportPreviewSelection();
    expect(selection.select(["missing", "far"], store, viewport, camera)).toEqual(["far"]);
  });

  it("waits for a viewport for large selections and releases retained ids on selection replacement", () => {
    const store = new FakeSceneStore();
    const ids = Array.from({ length: 300 }, (_, index) => String(index));
    for (const id of ids) store.records.set(id, fakeRectangleRecord(id, 0, 30));
    const selection = new ViewportPreviewSelection();
    expect(selection.select(ids, store, undefined, camera)).toEqual([]);
    expect(selection.select(ids, store, viewport, camera)).toHaveLength(256);
    expect(selection.select(["missing"], store, viewport, camera)).toEqual([]);
  });
});
