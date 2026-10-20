import { expect, it, vi } from "vitest";

import { prepareReplacementCandidatesTimeSliced } from "../../../src/domain/store/replacement-planner";
import { ElementStore } from "../../../src/domain/store/public";
import type { EndpointReference } from "../../../src/domain/store/types";
import { connectionChain } from "../../fixtures/domain/connection-chain";
import * as anchors from "../../../src/domain/geometry/anchors";
import { ConnectedSelectionPreviewSession } from "../../../src/editor/selection/public";
import { editLinearEndpointFromWorld } from "../../../src/editor/selection/transforms";

it("checks the shared deadline between record reads across 10,000 connected lines", async () => {
  const elements = connectionChain(10_000);
  const store = new ElementStore(elements);
  const last = elements[elements.length - 1]!;
  const before = store.get(last.id);
  const styled = { ...last, style: { ...last.style, outlineOpacity: 0.5 } };
  const reconnected = {
    ...styled,
    startConnection: { ...last.startConnection!, targetId: elements[elements.length - 3]!.id },
  };
  let reads = 0;
  let sliceReads = 0;
  let readsSinceCheck = 0;
  let maximumReadsBetweenChecks = 0;
  let yields = 0;
  const ports = {
    getRecord: (id: string) => {
      reads += 1;
      sliceReads += 1;
      readsSinceCheck += 1;
      // The injected scheduler expires after 32 real reads, not after loop iterations.
      expect(sliceReads).toBeLessThanOrEqual(32);
      return store.get(id)!;
    },
    getReferences: (id: string) => {
      const references: EndpointReference[] = [];
      store.visitDependents(id, (reference) => references.push(reference));
      return references;
    },
    onReverseVisit: () => undefined,
  };
  const scheduler = {
    shouldYield: () => {
      maximumReadsBetweenChecks = Math.max(maximumReadsBetweenChecks, readsSinceCheck);
      readsSinceCheck = 0;
      return sliceReads >= 32;
    },
    yieldControl: async () => {
      yields += 1;
      sliceReads = 0;
      expect(store.get(last.id)).toBe(before);
    },
  };

  const paintPlan = await prepareReplacementCandidatesTimeSliced([styled], ports, scheduler);
  const connectionPlan = await prepareReplacementCandidatesTimeSliced(
    [reconnected],
    ports,
    scheduler,
  );

  expect(paintPlan).not.toBe("cancelled");
  expect(connectionPlan).not.toBe("cancelled");
  if (paintPlan === "cancelled" || connectionPlan === "cancelled") return;
  expect(paintPlan.candidates.map(({ domains }) => domains)).toEqual([["paint"]]);
  expect(connectionPlan.candidates.map(({ domains }) => domains)).toEqual([
    ["paint", "connection"],
  ]);
  expect(reads).toBeGreaterThanOrEqual(19_998);
  expect(reads).toBeLessThanOrEqual(20_032);
  expect(maximumReadsBetweenChecks).toBeLessThanOrEqual(2);
  expect(yields).toBeGreaterThan(600);
  expect(store.get(last.id)).toBe(before);
  expect(store.instrumentation.publishedDeltas).toBe(0);
});

it("bounds targeted feedback to the exact-preview cohort while retaining local 10,000-line feedback", () => {
  const elements = connectionChain(10_000);
  const store = new ElementStore(elements);
  const cases = [
    { cohort: 9_999, previewCount: 1 },
    { cohort: 257, previewCount: 1 },
    { cohort: 256, previewCount: 256 },
  ].map(({ cohort, previewCount }) => {
    const selected = elements[elements.length - cohort]!;
    const session = new ConnectedSelectionPreviewSession(store, [selected], new Set([selected.id]));
    return { selected, session, previewCount };
  });
  const resolve = vi.spyOn(anchors, "resolveShapeAnchor");
  const rounding = vi.spyOn(Math, "round");
  const get = vi.spyOn(store, "get");
  const visit = vi.spyOn(store, "visitDependents");
  try {
    for (const { selected, session, previewCount } of cases) {
      resolve.mockClear();
      rounding.mockClear();
      const point = { x: 450, y: 180 };
      const edited = editLinearEndpointFromWorld(selected, "start", point, { connection: null });
      const preview = session.updateTargets([edited]);
      const roundCalls = rounding.mock.calls.length;
      const anchorCalls = resolve.mock.calls.length;
      expect(preview.elements).toHaveLength(previewCount);
      expect(
        preview.elements.every(({ start }) => start.x === point.x && start.y === point.y),
      ).toBe(true);
      expect(preview.elements[0]?.id).toBe(selected.id);
      expect(anchorCalls).toBeLessThanOrEqual(previewCount - 1);
      // A straight dependent resolves one anchor and three edit points, two scalar rounds each.
      expect(roundCalls).toBeLessThanOrEqual(previewCount * 8);
      expect(get).not.toHaveBeenCalled();
      expect(visit).not.toHaveBeenCalled();
    }
    expect(store.instrumentation.publishedDeltas).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
});
