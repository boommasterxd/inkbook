import { describe, expect, it } from "vitest";

import {
  calculateElementBounds,
  canonicalPoint,
  isWithinPageBounds,
  resolveShapeAnchor,
} from "../../../../src/domain/geometry/public";
import type {
  ArrowElementV1,
  BoxShapeElementV1,
  InkElementV1,
  LineElementV1,
} from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/public";
import { IDS, rectangle } from "../../domain/store/fixtures";

const LINE_STYLE = {
  outlineColor: { type: "theme-text" as const },
  outlineOpacity: 1,
  outlineStyle: "solid" as const,
  outlineWidth: 12 as const,
};

function element(store: ElementStore, id: string): InkElementV1 {
  return store.get(id)?.element as InkElementV1;
}

function connectedArrow(
  target: BoxShapeElementV1,
  id: string,
  position: "top-left" | "top-right",
  end: Readonly<{ x: number; y: number }>,
): ArrowElementV1 {
  const start = resolveShapeAnchor(target, { kind: "box", position });
  if (start === null) throw new Error("Expected a box anchor.");
  return {
    bend: null,
    createdAt: 3,
    end: { ...end },
    endConnection: null,
    endNode: "none",
    id,
    kind: "arrow",
    pivot: canonicalPoint({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }),
    rotation: 0,
    start,
    startConnection: {
      anchor: { kind: "box", position },
      targetId: target.id,
    },
    startNode: "circle",
    style: LINE_STYLE,
  };
}

function connectedThickLine(
  target: BoxShapeElementV1,
  id: string,
  position: "top-left" | "top-right",
  end: Readonly<{ x: number; y: number }>,
): LineElementV1 {
  return {
    ...connectedArrow(target, id, position, end),
    endNode: "none",
    kind: "line",
    startNode: "none",
  };
}

describe("connected selection page-edge correction", () => {
  it.each([
    {
      delta: { x: -47, y: 0 },
      edge: "left",
      kind: "line",
      target: rectangle(IDS.target, 50, 100),
    },
    {
      delta: { x: 45, y: 0 },
      edge: "right",
      kind: "arrow",
      target: rectangle(IDS.target, 1_800, 100),
    },
    {
      delta: { x: 0, y: -47 },
      edge: "top",
      kind: "line",
      target: rectangle(IDS.target, 500, 50),
    },
  ])(
    "corrects the target and its thick $kind together at the $edge page edge",
    ({ delta, kind, target }) => {
      const freeEnd =
        delta.x < 0 ? { x: 300, y: 100 } : delta.x > 0 ? { x: 1_700, y: 100 } : { x: 500, y: 200 };
      const position = delta.x > 0 ? "top-right" : "top-left";
      const createDependent = kind === "line" ? connectedThickLine : connectedArrow;
      const dependent = createDependent(
        target,
        "00000000-0000-4000-8000-000000000091",
        position,
        freeEnd,
      );
      const store = new ElementStore([target, dependent]);
      store.resetInstrumentation();
      const session = moveSession(store, target);
      const rawTarget = movedTarget(target, delta);

      expect(isWithinPageBounds(calculateElementBounds(rawTarget))).toBe(true);
      const preview = session.update({
        x: target.pivot.x + delta.x,
        y: target.pivot.y + delta.y,
      });
      expect(preview.exactElements).toHaveLength(2);
      expect(preview.exactElements.every(withinPage)).toBe(true);
      expect(preview.exactElements.find(({ id }) => id === target.id)).not.toEqual(rawTarget);

      const prepared = session.prepareCommit();
      if (prepared.status !== "ready") throw new Error("Expected a corrected target commit.");
      store.replaceMany(prepared.replacements);
      expect(isWithinPageBounds(store.get(target.id)!.bounds)).toBe(true);
      expect(isWithinPageBounds(store.get(dependent.id)!.bounds)).toBe(true);
      expect(store.instrumentation).toMatchObject({ fullStoreScans: 0 });
      expect(store.instrumentation.reverseDependencyVisits).toBeGreaterThan(0);
    },
  );
});

describe("connected selection compound page bounds", () => {
  it("applies shared correction after a target scale", () => {
    const target = rectangle(IDS.target, 1_800, 100);
    const arrow = connectedArrow(target, "00000000-0000-4000-8000-000000000097", "top-right", {
      x: 1_700,
      y: 100,
    });
    const store = new ElementStore([target, arrow]);
    const session = new SelectionHandleSession({
      action: { anchor: { x: 1_800, y: 100 }, kind: "scale", position: "bottom-right" },
      elements: [element(store, target.id)],
      planner: store,
      startPointer: { x: 2_000, y: 200 },
    });

    const preview = session.update({ x: 2_045, y: 200 });

    expect(preview.exactElements).toHaveLength(2);
    expect(preview.exactElements.every(withinPage)).toBe(true);
    const correctedTarget = preview.exactElements.find(({ id }) => id === target.id);
    expect(correctedTarget).toMatchObject({ width: 245 });
    if (correctedTarget?.kind !== "rectangle") throw new Error("Expected a rectangle target.");
    expect(correctedTarget.x).toBeLessThan(target.x);
  });

  it("recomputes rotated anchors for multiple dependents after correction", () => {
    const target = { ...rectangle(IDS.target, 1_750, 200), rotation: 45 };
    const arrow = connectedArrow(target, "00000000-0000-4000-8000-000000000092", "top-right", {
      x: 1_550,
      y: 300,
    });
    const secondArrow = connectedArrow(target, "00000000-0000-4000-8000-000000000093", "top-left", {
      x: 1_500,
      y: 450,
    });
    const store = new ElementStore([target, arrow, secondArrow]);

    const preview = moveSession(store, target).update({
      x: target.pivot.x + 90,
      y: target.pivot.y,
    });

    expect(preview.exactElements).toHaveLength(3);
    const correctedTarget = preview.exactElements.find(({ id }) => id === target.id);
    if (correctedTarget?.kind !== "rectangle") throw new Error("Expected a rectangle target.");
    expect(correctedTarget.x).toBeLessThan(target.x + 90);
    for (const dependent of [arrow, secondArrow]) {
      const changed = preview.exactElements.find(({ id }) => id === dependent.id);
      if (changed?.kind !== "arrow") throw new Error("Expected an arrow dependent.");
      expect(changed.start).toEqual(
        resolveShapeAnchor(correctedTarget, changed.startConnection!.anchor),
      );
      expect(withinPage(changed)).toBe(true);
    }
  });

  it("rejects a target and dependent that cannot fit the page together", () => {
    const target = rectangle(IDS.target, 900, 100);
    const arrow = connectedArrow(target, "00000000-0000-4000-8000-000000000094", "top-right", {
      x: 6,
      y: 100,
    });
    const store = new ElementStore([target, arrow]);
    const session = moveSession(store, target);

    expect(session.update({ x: target.pivot.x + 946, y: target.pivot.y })).toMatchObject({
      exactElements: [],
      exactPreviewTruncated: false,
    });
    expect(session.prepareCommit()).toEqual({ status: "noop" });
    expect(element(store, target.id)).toEqual(target);
    expect(element(store, arrow.id)).toEqual(arrow);
  });
});

describe("connected selection page-bound lifecycle", () => {
  it("cancels planning without changing the store", async () => {
    const target = rectangle(IDS.target, 50, 100);
    const arrow = connectedArrow(target, "00000000-0000-4000-8000-000000000095", "top-left", {
      x: 300,
      y: 100,
    });
    const store = new ElementStore([target, arrow]);
    const session = moveSession(store, target);
    session.update({ x: target.pivot.x - 40, y: target.pivot.y });
    let yields = 0;

    await expect(
      session.prepareCommitTimeSliced({
        isCancelled: () => yields >= 7,
        shouldYield: () => true,
        yieldControl: async () => {
          yields += 1;
        },
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(element(store, target.id)).toEqual(target);
    expect(element(store, arrow.id)).toEqual(arrow);
  });

  it("leaves an already valid candidate at its requested translation", () => {
    const target = rectangle(IDS.target, 500, 200);
    const arrow = connectedArrow(target, "00000000-0000-4000-8000-000000000096", "top-right", {
      x: 400,
      y: 200,
    });
    const store = new ElementStore([target, arrow]);
    store.resetInstrumentation();

    const preview = moveSession(store, target).update({
      x: target.pivot.x + 10,
      y: target.pivot.y + 20,
    });

    expect(preview.exactElements.find(({ id }) => id === target.id)).toMatchObject({
      x: target.x + 10,
      y: target.y + 20,
    });
    const changedArrow = preview.exactElements.find(({ id }) => id === arrow.id);
    if (changedArrow?.kind !== "arrow") throw new Error("Expected an arrow dependent.");
    expect(changedArrow.end).toEqual(arrow.end);
    expect(store.instrumentation).toMatchObject({
      fullStoreScans: 0,
      reverseDependencyVisits: 1,
    });
  });
});

describe("selected connected dependent correction", () => {
  it("moves free geometry once and resolves the endpoint from the corrected target", () => {
    const target = rectangle(IDS.target, 50, 100);
    const arrow = connectedArrow(target, "00000000-0000-4000-8000-000000000098", "top-left", {
      x: 300,
      y: 100,
    });
    const store = new ElementStore([target, arrow]);
    const session = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [element(store, target.id), element(store, arrow.id)],
      planner: store,
      startPointer: target.pivot,
    });

    const preview = session.update({ x: target.pivot.x - 47, y: target.pivot.y });
    const correctedTarget = preview.exactElements.find(({ id }) => id === target.id);
    const correctedArrow = preview.exactElements.find(({ id }) => id === arrow.id);
    if (correctedTarget?.kind !== "rectangle" || correctedArrow?.kind !== "arrow") {
      throw new Error("Expected corrected target and arrow candidates.");
    }
    expect(correctedTarget.x).toBe(6);
    expect(correctedArrow.start).toEqual({ x: 6, y: 100 });
    expect(correctedArrow.end).toEqual({ x: 256, y: 100 });

    const prepared = session.prepareCommit();
    if (prepared.status !== "ready") throw new Error("Expected a corrected selection commit.");
    expect(prepared.replacements.map(({ id }) => id)).toEqual([target.id, arrow.id]);
  });
});

function moveSession(store: ElementStore, target: BoxShapeElementV1): SelectionHandleSession {
  return new SelectionHandleSession({
    action: { kind: "move" },
    elements: [element(store, target.id)],
    planner: store,
    startPointer: target.pivot,
  });
}

function movedTarget(
  target: BoxShapeElementV1,
  delta: Readonly<{ x: number; y: number }>,
): BoxShapeElementV1 {
  return {
    ...target,
    pivot: { x: target.pivot.x + delta.x, y: target.pivot.y + delta.y },
    x: target.x + delta.x,
    y: target.y + delta.y,
  };
}

function withinPage(candidate: InkElementV1): boolean {
  return isWithinPageBounds(calculateElementBounds(candidate));
}
