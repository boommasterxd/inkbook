import { afterEach, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/public";
import { connectionChain } from "../../../fixtures/domain/connection-chain";
import { uuid } from "../../domain/schema/fixtures";
import { rectangle } from "../../domain/store/fixtures";
import { pausedWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import type { WorkScheduler } from "../../../../src/domain/scheduling/work-scheduler";

afterEach(() => vi.restoreAllMocks());

function connectedEndpointSession(scheduler?: WorkScheduler) {
  const elements = connectionChain(3);
  const source = elements[elements.length - 1]!;
  const target = rectangle(uuid(50_000), 900, 300);
  const store = new ElementStore([...elements, target]);
  const onPreviewReady = vi.fn();
  const session = new SelectionHandleSession({
    action: { kind: "linear-endpoint", elementId: source.id, endpoint: "end" },
    elements: [store.get(source.id)!.element as InkElementV1],
    planner: store,
    startPointer: source.end,
    onPreviewReady,
    snap: {
      features: { angles: false, bends: true, connections: true, structures: true },
      pointerType: "mouse",
      zoom: 1,
      ...(scheduler === undefined ? {} : { scheduler }),
      spatial: {
        query: (_bounds, sink) => sink.add(target.id),
        beginQuery: (bounds) => store.beginQuery(bounds),
      },
      targets: {
        get: (id) => {
          const anchors = store.getSemanticAnchors(id);
          const rank = store.getRank(id)?.rank;
          return anchors === null || rank === undefined ? null : { anchors, rank };
        },
      },
    },
  });
  const pointer = { x: target.x + 2, y: target.y + 3 };
  const disabled = { angles: false, bends: true, connections: false, structures: true };
  const commitScheduler = { shouldYield: () => false, yieldControl: async () => undefined };
  return { session, source, target, store, pointer, disabled, commitScheduler, onPreviewReady };
}

it.each([false, true])(
  "respects the latest endpoint snapping override in a sliced commit, reenabled=%s",
  async (reenabled) => {
    const { session, target, store, source, pointer, disabled, commitScheduler } =
      connectedEndpointSession();
    expect(session.update(pointer).snapCandidate?.targetId).toBe(target.id);

    const free = session.update(pointer, { snapFeatures: disabled });
    expect(free.snapCandidate).toBeNull();
    expect(free.exactElements[0]).toMatchObject({ end: pointer, endConnection: null });
    if (reenabled) {
      session.update(pointer, { snapFeatures: { ...disabled, connections: true } });
      expect(session.preview.snapCandidate?.targetId).toBe(target.id);
    }
    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
    const prepared = await session.prepareCommitTimeSliced(commitScheduler);
    if (prepared.status !== "ready") throw new Error("Expected a prepared endpoint edit.");
    store.replaceMany(prepared.replacements);
    expect(store.get(source.id)?.element).toMatchObject({
      end: reenabled ? { x: target.x, y: target.y } : pointer,
      endConnection: reenabled ? { targetId: target.id } : null,
    });
    expect(session.preview.snapCandidate?.targetId ?? null).toBe(reenabled ? target.id : null);
    session.cancel();
  },
);

it("cancels pending endpoint snapping without late feedback after disabling it", async () => {
  const { scheduler, resume } = pausedWorkScheduler();
  const { session, store, source, pointer, disabled, commitScheduler, onPreviewReady } =
    connectedEndpointSession(scheduler);
  session.update(pointer);
  expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
  const pendingCommit = session.prepareCommitTimeSliced(commitScheduler);
  session.update(pointer, { snapFeatures: disabled });
  resume();
  expect(await pendingCommit).toEqual({ status: "cancelled" });
  const prepared = await session.prepareCommitTimeSliced(commitScheduler);
  if (prepared.status !== "ready") throw new Error("Expected a free endpoint commit.");
  store.replaceMany(prepared.replacements);
  expect(onPreviewReady).not.toHaveBeenCalled();
  expect(session.preview.snapCandidate).toBeNull();
  expect(session.preview.exactElements[0]).toMatchObject({ end: pointer, endConnection: null });
  expect(store.get(source.id)?.element).toMatchObject({ end: pointer, endConnection: null });
  session.cancel();
});

it("defers a terminal line handle whose forward graph is invisible to the reverse count", async () => {
  const elements = connectionChain(3);
  const store = new ElementStore(elements);
  const last = elements[elements.length - 1]!;
  const plan = vi.spyOn(store, "planReplacements");
  const session = new SelectionHandleSession({
    action: { kind: "linear-endpoint", elementId: last.id, endpoint: "end" },
    elements: [store.get(last.id)!.element as InkElementV1],
    planner: store,
    startPointer: last.end,
  });

  expect(store.countReverseDependencies([last.id], 256)).toBe(0);
  const preview = session.update({ x: 450, y: 120 });
  expect(preview.exactPreviewTruncated).toBe(true);
  expect(preview.exactElements[0]).toMatchObject({ end: { x: 450, y: 120 } });
  expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
  expect(plan).not.toHaveBeenCalled();
  const materialized = await session.prepareCommitTimeSliced({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  if (materialized.status !== "ready") throw new Error("Expected a prepared handle edit.");
  expect(materialized.replacements[0]).toMatchObject({
    end: { x: 450, y: 120 },
    startConnection: last.startConnection,
  });
});

it("defers a newly snapped linear target while keeping free endpoint previews immediate", () => {
  const elements = connectionChain(3);
  const target = elements[elements.length - 1]!;
  const source = {
    ...elements[0]!,
    id: uuid(50_000),
    start: { x: 600, y: 100 },
    end: { x: 900, y: 100 },
    pivot: { x: 750, y: 100 },
  };
  const store = new ElementStore([...elements, source]);
  const plan = vi.spyOn(store, "planReplacements");
  const session = new SelectionHandleSession({
    action: { kind: "linear-endpoint", elementId: source.id, endpoint: "end" },
    elements: [store.get(source.id)!.element as InkElementV1],
    planner: store,
    startPointer: source.end,
    snap: {
      pointerType: "mouse",
      zoom: 1,
      spatial: { query: (_bounds, sink) => sink.add(target.id) },
      targets: { get: () => ({ anchors: store.getSemanticAnchors(target.id)!, rank: 2 }) },
    },
  });

  const free = session.update({ x: 950, y: 100 });
  expect(free.exactPreviewTruncated).toBe(false);
  expect(free.exactElements[0]).toMatchObject({ end: { x: 950, y: 100 } });
  expect(session.prepareCommit().status).toBe("ready");
  plan.mockClear();

  const snapped = session.update(target.start);
  expect(snapped.snapCandidate?.targetId).toBe(target.id);
  expect(snapped.exactPreviewTruncated).toBe(true);
  expect(snapped.exactElements[0]).toMatchObject({
    end: target.start,
    endConnection: { targetId: target.id, anchor: { kind: "linear-endpoint" } },
  });
  expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
  expect(plan).not.toHaveBeenCalled();
});
