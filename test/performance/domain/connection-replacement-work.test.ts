import { expect, it, vi } from "vitest";

import { prepareReplacementCandidatesTimeSliced } from "../../../src/domain/store/replacements/replacement-planner";
import { ElementStore } from "../../../src/domain/store/public";
import type { EndpointReference } from "../../../src/domain/store/types";
import { connectionChain } from "../../fixtures/domain/connection-chain";
import * as anchors from "../../../src/domain/geometry/anchors";
import { ConnectedSelectionPreviewSession } from "../../../src/editor/selection/public";
import { immediateWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";
import { editLinearEndpointFromWorld } from "../../../src/editor/selection/transform/transforms";

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

it("prepares a 10,000-line ancestry once and materializes only requested visible endpoints", async () => {
  const elements = connectionChain(10_000);
  const store = new ElementStore(elements);
  const selected = elements[0]!;
  store.resetInstrumentation();
  const session = new ConnectedSelectionPreviewSession(store, [selected], new Set([selected.id]));
  expect(store.instrumentation.reverseDependencyVisits).toBe(257);
  expect(session.update({ kind: "translate", delta: { x: 30, y: 40 } }).elements).toEqual([]);
  let checkpointVisits = store.instrumentation.reverseDependencyVisits;
  let yields = 0;
  const scheduler = {
    ...immediateWorkScheduler(),
    checkpoint: () => {
      const visits = store.instrumentation.reverseDependencyVisits;
      expect(visits - checkpointVisits).toBeLessThanOrEqual(32);
      if (visits - checkpointVisits < 32) return undefined;
      checkpointVisits = visits;
      yields += 1;
      return Promise.resolve();
    },
  };
  await expect(session.prepare(scheduler, new AbortController().signal)).resolves.toBe(true);
  expect(yields).toBeGreaterThan(300);
  expect(store.instrumentation.reverseDependencyVisits).toBe(9_999);
  const get = vi.spyOn(store, "get");
  const rounding = vi.spyOn(Math, "round");
  try {
    let ids: readonly string[] | undefined;
    let previous: ((id: string) => unknown) | undefined;
    store.resetInstrumentation();
    for (const delta of [
      { x: 30, y: 40 },
      { x: -30, y: -40 },
      { x: 60, y: 20 },
    ]) {
      rounding.mockClear();
      const preview = session.update({ kind: "translate", delta });
      expect(preview.elements).toEqual([]);
      expect(preview.progressive?.ids).toHaveLength(9_999);
      if (ids !== undefined) expect(preview.progressive?.ids).toBe(ids);
      ids = preview.progressive!.ids;
      expect(previous?.(elements[9_999]!.id)).toBeUndefined();
      const last = preview.progressive!.materialize(elements[9_999]!.id);
      expect(last?.start).toEqual({ x: 100 + delta.x, y: 100 + delta.y });
      expect(rounding.mock.calls.length).toBeLessThanOrEqual(16);
      previous = preview.progressive!.materialize;
    }
    expect(get).not.toHaveBeenCalled();
    expect(store.instrumentation.reverseDependencyVisits).toBe(0);
    session.dispose();
    expect(previous?.(elements[9_999]!.id)).toBeUndefined();
  } finally {
    session.dispose();
    vi.restoreAllMocks();
  }
});

it("cancels a suspended connection plan and invalidates prepared materializers on source changes", async () => {
  const elements = connectionChain(1_000);
  const store = new ElementStore(elements);
  const selected = elements[0]!;
  const session = new ConnectedSelectionPreviewSession(store, [selected], new Set([selected.id]));
  const abort = new AbortController();
  let resume!: () => void;
  const checkpoint = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  const pending = session.prepare({ ...immediateWorkScheduler(), checkpoint }, abort.signal);
  const visits = store.instrumentation.reverseDependencyVisits;
  abort.abort();
  resume();
  await expect(pending).resolves.toBe(false);
  expect(store.instrumentation.reverseDependencyVisits).toBe(visits);
  session.dispose();

  const fresh = new ConnectedSelectionPreviewSession(store, [selected], new Set([selected.id]));
  try {
    await fresh.prepare(immediateWorkScheduler(), new AbortController().signal);
    const preview = fresh.update({ kind: "translate", delta: { x: 30, y: 40 } });
    expect(preview.progressive!.materialize(elements[999]!.id)).toBeDefined();
    store.replace(selected.id, { ...selected, style: { ...selected.style, outlineOpacity: 0.5 } });
    expect(preview.progressive!.materialize(elements[999]!.id)).toBeUndefined();
  } finally {
    fresh.dispose();
  }
});

it("checks central admission while every reverse edge points into the already selected graph", async () => {
  const elements = connectionChain(10_000);
  const store = new ElementStore(elements);
  store.resetInstrumentation();
  const session = new ConnectedSelectionPreviewSession(
    store,
    elements,
    new Set(elements.map(({ id }) => id)),
  );
  expect(store.instrumentation.reverseDependencyVisits).toBe(0);
  let checkedVisits = 0;
  let yields = 0;
  try {
    await session.prepare(
      {
        ...immediateWorkScheduler(),
        checkpoint: () => {
          const visits = store.instrumentation.reverseDependencyVisits;
          expect(visits - checkedVisits).toBeLessThanOrEqual(32);
          if (visits - checkedVisits < 32) return undefined;
          checkedVisits = visits;
          yields += 1;
          return Promise.resolve();
        },
      },
      new AbortController().signal,
    );
    expect(store.instrumentation.reverseDependencyVisits).toBe(9_999);
    expect(yields).toBeGreaterThan(300);
    expect(store.instrumentation.fullStoreScans).toBe(0);
  } finally {
    session.dispose();
  }
});
