import { describe, expect, it, vi } from "vitest";

import {
  routeSceneDelta,
  type SceneDeltaRoutingPorts,
} from "../../../../src/rendering/scene/scene-delta-router";
import { fakeRectangleRecord } from "./fakes";
import * as geometry from "../../../../src/domain/geometry/public";

it.each(["remove", "restore"] as const)(
  "routes complete %s membership with stored bounds and progressive order",
  (kind) => {
    const { ports, spies } = routingPorts();
    const record = fakeRectangleRecord("member", 0, 10);
    const removing = kind === "remove";
    if (!removing) spies.readRecord.mockReturnValue(record);
    const bounds = vi.spyOn(geometry, "calculateElementBounds");
    try {
      routeSceneDelta(
        {
          affected: [
            {
              id: record.id,
              before: removing ? record.element : null,
              after: removing ? null : record.element,
              beforeBounds: removing ? record.bounds : null,
              afterBounds: removing ? null : record.bounds,
              domains: ["order", "visibility"],
            },
          ],
        },
        ports,
      );
      expect(spies.markOrders).not.toHaveBeenCalled();
      expect(spies.markOrderVisibilityDirty).not.toHaveBeenCalled();
      expect(spies.invalidateForChanges).toHaveBeenCalledWith(
        removing ? record.bounds : null,
        removing ? null : record.bounds,
        record.id,
      );
      expect(spies.invalidateVisibility).toHaveBeenCalledOnce();
      expect(spies.releaseId).toHaveBeenCalledTimes(removing ? 1 : 0);
      expect(spies.beginRemoval).toHaveBeenCalledTimes(removing ? 1 : 0);
      expect(bounds).not.toHaveBeenCalled();
    } finally {
      bounds.mockRestore();
    }
  },
);

it.each([false, true])("routes complete batched removals with reuse admission %s", (reuse) => {
  const { ports, spies } = routingPorts();
  spies.beginRemoval.mockReturnValue(reuse);
  const records = [fakeRectangleRecord("a", 0, 10), fakeRectangleRecord("b", 1, 20)];
  routeSceneDelta(
    {
      affected: records.map((record) => ({
        id: record.id,
        before: record.element,
        after: null,
        beforeBounds: record.bounds,
        afterBounds: null,
        domains: ["order" as const, "visibility" as const],
      })),
    },
    ports,
  );
  expect(spies.markOrders).not.toHaveBeenCalled();
  expect(spies.markOrderVisibilityDirty).not.toHaveBeenCalled();
  expect(spies.beginRemoval).toHaveBeenCalledOnce();
  expect(spies.invalidateForChanges).toHaveBeenCalledTimes(reuse ? 0 : 2);
  expect(spies.invalidateVisibility).toHaveBeenCalledOnce();
  if (reuse) expect(spies.invalidateVisibility).toHaveBeenCalledWith(true);
  else expect(spies.invalidateVisibility).toHaveBeenCalledWith();
  expect(spies.releaseId).toHaveBeenCalledTimes(2);
});

it.each(["geometry", "paint", "order", "visibility"] as const)(
  "releases detached %s records only when geometry changed or the element disappeared",
  (domain) => {
    const { ports, spies } = routingPorts();
    spies.readRecord.mockReturnValue(fakeRectangleRecord("retained", 0, 10));
    const delta = { affected: [{ domains: [domain], id: "retained" }] };

    routeSceneDelta(delta, ports);
    expect(spies.invalidateDetached).toHaveBeenCalledTimes(domain === "geometry" ? 1 : 0);
    spies.readRecord.mockReturnValue(undefined);
    routeSceneDelta(delta, ports);
    expect(spies.invalidateDetached).toHaveBeenCalledTimes(domain === "geometry" ? 2 : 1);
  },
);

it("invalidates detached deletions after order and visibility cancellation retained their pending nodes", () => {
  const { ports, spies } = routingPorts();
  routeSceneDelta(
    { affected: [{ id: "removed", after: null, domains: ["order", "visibility"] }] },
    ports,
  );
  const invalidated = spies.invalidateDetached.mock.invocationCallOrder[0];
  expect(invalidated).toBeGreaterThan(spies.markOrders.mock.invocationCallOrder[0]!);
  expect(invalidated).toBeGreaterThan(spies.invalidateVisibility.mock.invocationCallOrder[0]!);
});

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
    | "readRecord"
    | "beginRemoval"
    | "invalidateDetached"
    | "invalidateForChanges"
    | "invalidatePath"
    | "invalidateRanks"
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
    readRecord: vi.fn(),
    beginRemoval: vi.fn().mockReturnValue(false),
    invalidateDetached: vi.fn(),
    invalidateForChanges: vi.fn(),
    invalidatePath: vi.fn(),
    invalidateRanks: vi.fn(),
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
    detachedCache: {
      invalidate: spies.invalidateDetached,
      invalidateRanks: spies.invalidateRanks,
    },
    content: {
      hasVisibilityWork: false,
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
    store: { get: spies.readRecord, query: vi.fn() },
    visibility: {
      beginRemoval: spies.beginRemoval,
      invalidateForChanges: spies.invalidateForChanges,
      releaseId: spies.releaseId,
    },
  } as unknown as SceneDeltaRoutingPorts;
  return { ports, spies };
}
