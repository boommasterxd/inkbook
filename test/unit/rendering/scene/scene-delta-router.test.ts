import { describe, expect, it, vi } from "vitest";

import {
  routeSceneDelta,
  type SceneDeltaRoutingPorts,
} from "../../../../src/rendering/scene/scene-delta-router";

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
    prepareElementRemoval: vi.fn(),
  };
  const ports = {
    content: {
      markGeometry: spies.markGeometry,
      markOrder: vi.fn(),
      markOrders: spies.markOrders,
      markPaint: spies.markPaint,
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
