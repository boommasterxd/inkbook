import { describe, expect, it, vi } from "vitest";

import type {
  CoordinateSystemElementV1,
  TableElementV1,
} from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { type ElementRecord } from "../../../../src/domain/store/types";

import {
  axisConnectedLine,
  connectedLine,
  coordinateSystem,
  highlighter,
  IDS,
  rectangle,
} from "./fixtures";

describe("ElementStore collapsed connections", () => {
  it("keeps a connection when its target collapses the line to a point", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);

    store.replace(target.id, rectangle(target.id, line.end.x, line.end.y));

    expect(store.get(line.id)?.element).toMatchObject({
      start: line.end,
      end: line.end,
      pivot: line.end,
      startConnection: line.startConnection,
    });
  });
});

describe("ElementStore connection transactions", () => {
  it("propagates target geometry through the reverse map in the same delta", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const other = rectangle(IDS.other, 700, 100);
    const store = new ElementStore([target, line, other]);
    const previousLine = store.get(line.id)!;
    const previousOther = store.get(other.id)!;
    const moved = rectangle(target.id, 150, 120);
    store.resetInstrumentation();

    const delta = store.replace(target.id, moved);
    const resolvedLine = store.get(line.id)!;

    expect(resolvedLine.element.kind).toBe("line");
    if (resolvedLine.element.kind !== "line") throw new Error("Expected line record.");
    expect(resolvedLine.element.start).toEqual({ x: 150, y: 120 });
    expect(resolvedLine).not.toBe(previousLine);
    expect(store.get(other.id)).toBe(previousOther);
    expect(delta?.changes.map(({ id }) => id)).toEqual([target.id, line.id]);
    expect(delta?.changes[1]?.domains).toEqual(["geometry"]);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 1,
    });
  });

  it("detaches dependents at their last resolved endpoint when a target is removed", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const listener = vi.fn(() => {
      expect(store.get(target.id)).toBeUndefined();
      const committed = store.get(line.id);
      expect(committed?.element.kind).toBe("line");
    });
    store.subscribe(listener);

    const delta = store.remove([target.id]);
    const remaining = store.get(line.id)!;

    expect(listener).toHaveBeenCalledTimes(1);
    expect(remaining.element.kind).toBe("line");
    if (remaining.element.kind !== "line") throw new Error("Expected line record.");
    expect(remaining.element.startConnection).toBeNull();
    expect(remaining.element.start).toEqual({ x: 100, y: 100 });
    expect(delta?.changes.find(({ id }) => id === line.id)?.domains).toEqual([
      "geometry",
      "order",
      "connection",
    ]);
    expect(delta?.changes.find(({ id }) => id === target.id)?.after).toBeNull();
  });

  it("maintains reverse membership incrementally when a connection changes", () => {
    const first = rectangle();
    const second = rectangle(IDS.other, 700, 100);
    const line = connectedLine(first);
    const store = new ElementStore([first, second, line]);
    const replacement = connectedLine(first);
    replacement.startConnection = {
      anchor: { kind: "box", position: "top-left" },
      targetId: second.id,
    };
    const firstReferences: string[] = [];
    const secondReferences: string[] = [];

    store.replace(line.id, replacement);
    store.visitDependents(first.id, ({ linearId }) => firstReferences.push(linearId));
    store.visitDependents(second.id, ({ linearId }) => secondReferences.push(linearId));

    expect(firstReferences).toEqual([]);
    expect(secondReferences).toEqual([line.id]);
  });

  it("detaches an axis connection when a 3D target becomes 2D", () => {
    const target = coordinateSystem();
    const line = axisConnectedLine();
    const store = new ElementStore([target, line]);
    const replacement: CoordinateSystemElementV1 = {
      ...target,
      axes: [target.axes[0], target.axes[1]],
      dimension: "2d",
    };

    const delta = store.replace(target.id, replacement);
    const committedLine = store.get(line.id)!.element;
    const references: string[] = [];
    store.visitDependents(target.id, ({ linearId }) => references.push(linearId));

    expect(committedLine.kind).toBe("line");
    if (committedLine.kind !== "line") throw new Error("Expected line record.");
    expect(committedLine.startConnection).toBeNull();
    expect(committedLine.start).toEqual({ x: 200, y: 400 });
    expect(delta?.changes.find(({ id }) => id === line.id)?.domains).toEqual(["connection"]);
    expect(references).toEqual([]);
  });
});

describe("ElementStore table separator transactions", () => {
  it("updates internal separators without visiting unchanged outer-anchor dependents", () => {
    const box = rectangle();
    const table: TableElementV1 = {
      columnWidth: 100,
      columns: 2,
      createdAt: box.createdAt,
      headerHeight: 30,
      height: box.height,
      id: box.id,
      kind: "table",
      pivot: box.pivot,
      rotation: box.rotation,
      style: {
        outlineColor: box.style.outlineColor,
        outlineOpacity: box.style.outlineOpacity,
        outlineStyle: box.style.outlineStyle,
        outlineWidth: box.style.outlineWidth,
      },
      x: box.x,
      y: box.y,
    };
    const line = connectedLine(box);
    const store = new ElementStore([table, line]);
    const lineRecord = store.get(line.id);
    store.resetInstrumentation();

    const delta = store.replace(table.id, {
      ...table,
      columnOffsets: [120],
      headerHeight: 40,
    });

    expect(delta?.changes.map(({ id }) => id)).toEqual([table.id]);
    expect(store.get(line.id)).toBe(lineRecord);
    expect(store.instrumentation.reverseDependencyVisits).toBe(0);
  });
});

describe("ElementStore linear endpoint propagation", () => {
  it("propagates a target move through connected linear endpoint dependents", () => {
    const target = rectangle();
    const first = connectedLine(target);
    const second = {
      ...connectedLine(target),
      end: { x: 500, y: 100 },
      id: "00000000-0000-4000-8000-000000000010",
      pivot: { x: 300, y: 100 },
      start: { ...first.start },
      startConnection: {
        anchor: { endpoint: "start" as const, kind: "linear-endpoint" as const },
        targetId: first.id,
      },
    };
    const store = new ElementStore([target, first, second]);

    const delta = store.replace(target.id, rectangle(target.id, 150, 120));

    expect(store.get(first.id)?.element).toMatchObject({ start: { x: 150, y: 120 } });
    expect(store.get(second.id)?.element).toMatchObject({ start: { x: 150, y: 120 } });
    expect(delta?.changes.map(({ id }) => id)).toEqual([target.id, first.id, second.id]);
  });

  it("rejects a replacement that would create a cycle between linear elements", () => {
    const first = { ...connectedLine(), startConnection: null };
    const second = {
      ...first,
      id: "00000000-0000-4000-8000-000000000010",
    };
    const store = new ElementStore([first, second]);

    const firstReplacement = {
      ...first,
      startConnection: {
        anchor: { endpoint: "start" as const, kind: "linear-endpoint" as const },
        targetId: second.id,
      },
    };
    const secondReplacement = {
      ...second,
      startConnection: {
        anchor: { endpoint: "start" as const, kind: "linear-endpoint" as const },
        targetId: first.id,
      },
    };

    expect(() => store.replaceMany([firstReplacement, secondReplacement])).toThrow(RangeError);
    const firstAfter = store.get(first.id)?.element;
    const secondAfter = store.get(second.id)?.element;
    expect(firstAfter?.kind).toBe("line");
    expect(secondAfter?.kind).toBe("line");
    if (firstAfter?.kind !== "line" || secondAfter?.kind !== "line") return;
    expect(firstAfter.startConnection).toBeNull();
    expect(secondAfter.startConnection).toBeNull();
  });
});

describe("ElementStore order transactions", () => {
  it("arranges each fixed band independently without replacing records or versions", () => {
    const first = rectangle(IDS.target, 100, 100);
    const second = rectangle(IDS.other, 500, 100);
    const highlight = highlighter();
    const store = new ElementStore([first, second, highlight]);
    const records = new Map<string, ElementRecord>([
      [first.id, store.get(first.id)!],
      [second.id, store.get(second.id)!],
      [highlight.id, store.get(highlight.id)!],
    ]);
    store.resetInstrumentation();

    const delta = store.arrange(new Set([first.id, highlight.id]), "bring-to-front");

    expect(store.materializeBandOrder("content")).toEqual([second.id, first.id]);
    expect(store.materializeBandOrder("highlight")).toEqual([highlight.id]);
    expect(delta?.changes.map(({ id }) => id)).toEqual([second.id, first.id]);
    expect(
      delta?.changes.every(({ domains }) => domains.length === 1 && domains[0] === "order"),
    ).toBe(true);
    for (const [id, record] of records) expect(store.get(id)).toBe(record);
    expect(store.instrumentation).toMatchObject({ fullStoreScans: 0, recordReplacements: 0 });
  });

  it("treats boundary arrange and identical exact order as no-ops", () => {
    const first = rectangle();
    const second = rectangle(IDS.other, 500, 100);
    const store = new ElementStore([first, second]);

    expect(store.arrange(new Set([second.id]), "bring-to-front")).toBeNull();
    expect(store.reorderBands({ content: [first.id, second.id], highlight: [] })).toBeNull();
  });

  it("validates exact band order before mutating it", () => {
    const first = rectangle();
    const second = rectangle(IDS.other, 500, 100);
    const store = new ElementStore([first, second, highlighter()]);

    expect(() =>
      store.reorderBands({ content: [first.id, first.id], highlight: [IDS.highlight] }),
    ).toThrow(RangeError);
    expect(() =>
      store.reorderBands({ content: [first.id, IDS.highlight], highlight: [IDS.highlight] }),
    ).toThrow(RangeError);
    expect(store.materializeBandOrder("content")).toEqual([first.id, second.id]);
  });
});

describe("ElementStore atomic band reorder", () => {
  it("reorders both complete bands atomically and restores them in one revision", () => {
    const first = rectangle();
    const second = rectangle(IDS.other, 500, 100);
    const firstHighlight = highlighter();
    const secondHighlight = {
      ...highlighter(),
      id: "00000000-0000-4000-8000-000000000006",
    };
    const store = new ElementStore([first, second, firstHighlight, secondHighlight]);
    const listener = vi.fn();
    store.subscribe(listener);
    const original = {
      content: [first.id, second.id],
      highlight: [firstHighlight.id, secondHighlight.id],
    } as const;
    const reversed = {
      content: [second.id, first.id],
      highlight: [secondHighlight.id, firstHighlight.id],
    } as const;

    const forward = store.reorderBands(reversed);

    expect(store.materializeBandOrder("content")).toEqual(reversed.content);
    expect(store.materializeBandOrder("highlight")).toEqual(reversed.highlight);
    expect(forward?.dirtyBands).toEqual({ content: true, highlight: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.reorderBands(reversed)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    expect(() =>
      store.reorderBands({
        content: original.content,
        highlight: [firstHighlight.id, firstHighlight.id],
      }),
    ).toThrow(RangeError);
    expect(store.materializeBandOrder("content")).toEqual(reversed.content);
    expect(store.materializeBandOrder("highlight")).toEqual(reversed.highlight);

    const reverse = store.reorderBands(original);
    expect(reverse).not.toBeNull();
    expect(store.materializeBandOrder("content")).toEqual(original.content);
    expect(store.materializeBandOrder("highlight")).toEqual(original.highlight);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("ElementStore order insertion and removal", () => {
  it("inserts at the back while reporting shifted ranks without replacing records", () => {
    const first = rectangle();
    const store = new ElementStore([first]);
    const previous = store.get(first.id)!;
    const second = rectangle(IDS.other, 500, 100);

    const delta = store.create(second, { placement: "back" });

    expect(store.materializeBandOrder("content")).toEqual([second.id, first.id]);
    expect(delta?.changes.find(({ id }) => id === first.id)?.domains).toEqual(["order"]);
    expect(store.get(first.id)).toBe(previous);
  });

  it("removes IDs from both bands in one atomic transaction", () => {
    const first = rectangle();
    const second = rectangle(IDS.other, 500, 100);
    const highlight = highlighter();
    const store = new ElementStore([first, second, highlight]);

    const delta = store.remove(new Set([first.id, highlight.id]));

    expect(delta?.changes.map(({ id }) => id)).toContain(first.id);
    expect(delta?.changes.map(({ id }) => id)).toContain(highlight.id);
    expect(store.materializeBandOrder("highlight")).toEqual([]);
    expect(store.materializeBandOrder("content")).toEqual([second.id]);
    expect(store.getRank(second.id)).toEqual({ band: "content", rank: 0 });
  });
});

describe("ElementStore directional arrange semantics", () => {
  it("brings each original selected run forward by one unselected element", () => {
    const elements = orderedRectangles(5);
    const store = new ElementStore(elements);

    store.arrange(new Set([elements[0]!.id, elements[2]!.id]), "bring-forward");

    expect(store.materializeBandOrder("content")).toEqual([
      elements[1]!.id,
      elements[0]!.id,
      elements[3]!.id,
      elements[2]!.id,
      elements[4]!.id,
    ]);
  });

  it("sends each original selected run backward by one unselected element", () => {
    const elements = orderedRectangles(4);
    const store = new ElementStore(elements);

    store.arrange(new Set([elements[1]!.id, elements[3]!.id]), "send-backward");

    expect(store.materializeBandOrder("content")).toEqual([
      elements[1]!.id,
      elements[0]!.id,
      elements[3]!.id,
      elements[2]!.id,
    ]);
  });
});

function orderedRectangles(count: number) {
  return Array.from({ length: count }, (_, index) =>
    rectangle(`00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`, 100 + index * 300),
  );
}
