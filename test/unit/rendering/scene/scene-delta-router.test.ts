import { describe, expect, it, vi } from "vitest";

import {
  routeSceneDelta,
  type SceneDeltaRoutingPorts,
} from "../../../../src/rendering/scene/scene-delta-router";
import { fakeRectangleRecord } from "./fakes";

describe("scene delta routing", () => {
  it("batches visibility invalidation while preserving every geometry mark", () => {
    const { ports, spies } = routingPorts();

    routeSceneDelta(
      {
        affected: [
          { domains: ["geometry"], id: "a" },
          { domains: ["geometry", "paint"], id: "b" },
        ],
      },
      ports,
    );

    expect(spies.prepareElementRemoval).not.toHaveBeenCalled();
    expect(spies.markGeometry).toHaveBeenCalledTimes(2);
    expect(spies.markGeometry).toHaveBeenNthCalledWith(1, "a");
    expect(spies.markGeometry).toHaveBeenNthCalledWith(2, "b");
    expect(spies.markPaint).toHaveBeenCalledOnce();
    expect(spies.invalidateForChanges).toHaveBeenCalledOnce();
    expect(spies.invalidateForChanges).toHaveBeenCalledWith();
    expect(spies.invalidateVisibility).toHaveBeenCalledOnce();
  });

  it("batches order cancellation and releases removed visibility state once", () => {
    const { ports, spies } = routingPorts();

    routeSceneDelta(
      {
        affected: [
          { after: null, domains: ["order", "visibility"], id: "a" },
          { after: null, domains: ["order", "visibility"], id: "b" },
        ],
      },
      ports,
    );

    expect(spies.markOrders).toHaveBeenCalledOnce();
    expect(spies.markOrders).toHaveBeenCalledWith(["a", "b"]);
    expect(spies.markOrderVisibilityDirty).toHaveBeenCalledOnce();
    expect(spies.prepareElementRemoval.mock.calls).toEqual([["a"], ["b"]]);
    expect(spies.releaseId).toHaveBeenCalledTimes(2);
    expect(spies.invalidatePath).toHaveBeenCalledTimes(2);
    expect(spies.invalidateForChanges).toHaveBeenCalledOnce();
    expect(spies.invalidateVisibility).toHaveBeenCalledOnce();
  });

  it("keeps one proven new element on progressive visibility publication", () => {
    const { ports, spies } = routingPorts();
    const element = fakeRectangleRecord("new", 0, 10).element;

    routeSceneDelta(
      {
        affected: [
          {
            before: null,
            after: element,
            domains: ["geometry", "paint", "order", "visibility"],
            id: element.id,
          },
        ],
      },
      ports,
    );

    expect(spies.markOrders).toHaveBeenCalledWith([element.id]);
    expect(spies.markOrderVisibilityDirty).not.toHaveBeenCalled();
    expect(spies.markGeometry).toHaveBeenCalledWith(element.id);
    expect(spies.invalidateVisibility).toHaveBeenCalledOnce();
    expect(spies.setElementFade).toHaveBeenCalledWith([element.id], null);
  });

  it.each(["multiple additions", "existing order", "unproven before state", "removal"] as const)(
    "keeps %s atomic",
    (caseName) => {
      const { ports, spies } = routingPorts();
      const first = fakeRectangleRecord("first", 0, 10).element;
      const second = fakeRectangleRecord("second", 1, 30).element;
      const affected =
        caseName === "multiple additions"
          ? [
              { before: null, after: first, domains: ["order" as const], id: first.id },
              { before: null, after: second, domains: ["order" as const], id: second.id },
            ]
          : caseName === "existing order"
            ? [{ before: first, after: first, domains: ["order" as const], id: first.id }]
            : caseName === "unproven before state"
              ? [{ after: first, domains: ["order" as const], id: first.id }]
              : [{ before: first, after: null, domains: ["order" as const], id: first.id }];

      routeSceneDelta({ affected }, ports);

      expect(spies.markOrders).toHaveBeenCalledWith(affected.map(({ id }) => id));
      expect(spies.markOrderVisibilityDirty).toHaveBeenCalledOnce();
    },
  );
});

function routingPorts(): {
  readonly ports: SceneDeltaRoutingPorts;
  readonly spies: Record<
    | "invalidateForChanges"
    | "invalidatePath"
    | "invalidateVisibility"
    | "markGeometry"
    | "markOrderVisibilityDirty"
    | "markOrders"
    | "markPaint"
    | "releaseId"
    | "setElementFade"
    | "prepareElementRemoval",
    ReturnType<typeof vi.fn>
  >;
} {
  const spies = {
    invalidateForChanges: vi.fn(),
    invalidatePath: vi.fn(),
    invalidateVisibility: vi.fn(),
    markGeometry: vi.fn(),
    markOrderVisibilityDirty: vi.fn(),
    markOrders: vi.fn(),
    markPaint: vi.fn(),
    releaseId: vi.fn(),
    setElementFade: vi.fn(),
    prepareElementRemoval: vi.fn(),
  };
  const ports = {
    content: {
      markGeometry: spies.markGeometry,
      markOrder: vi.fn(),
      markOrders: spies.markOrders,
      markPaint: spies.markPaint,
      setElementFade: spies.setElementFade,
      prepareElementRemoval: spies.prepareElementRemoval,
    },
    invalidateVisibility: spies.invalidateVisibility,
    markOrderVisibilityDirty: spies.markOrderVisibilityDirty,
    pathCache: { invalidate: spies.invalidatePath },
    store: { get: vi.fn(), query: vi.fn() },
    visibility: {
      invalidateForChanges: spies.invalidateForChanges,
      releaseId: spies.releaseId,
    },
  } as unknown as SceneDeltaRoutingPorts;
  return { ports, spies };
}
