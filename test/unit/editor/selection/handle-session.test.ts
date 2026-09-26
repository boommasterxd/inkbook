import { describe, expect, it, vi } from "vitest";

import { calculateElementBounds } from "../../../../src/domain/geometry/public";
import type {
  BoxShapeElementV1,
  InkElementV1,
  LineElementV1,
  StrokeElementV1,
} from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { SpatialQueryScratch } from "../../../../src/domain/spatial/index";
import { SelectionHandleSession } from "../../../../src/editor/selection/public";
import type { SpatialCandidateSink } from "../../../../src/editor/snapping/snap-candidate";
import { indexedStroke } from "../../../fixtures/editor/stroke";
import { connectedLine, coordinateSystem, IDS, rectangle } from "../../domain/store/fixtures";

const LINE_STYLE = {
  outlineColor: { type: "theme-text" as const },
  outlineOpacity: 1,
  outlineStyle: "solid" as const,
  outlineWidth: 4 as const,
};

function element(store: ElementStore, id: string): InkElementV1 {
  return store.get(id)?.element as InkElementV1;
}

function replacementPlan(replacements: readonly InkElementV1[]) {
  return { elements: replacements, replacements };
}

function freeLine(): LineElementV1 {
  return {
    bend: null,
    createdAt: 2,
    end: { x: 450, y: 150 },
    endConnection: null,
    endNode: "none",
    id: IDS.line,
    kind: "line",
    pivot: { x: 375, y: 150 },
    rotation: 0,
    start: { x: 300, y: 150 },
    startConnection: null,
    startNode: "none",
    style: LINE_STYLE,
  };
}

function ellipse(): BoxShapeElementV1 {
  return {
    ...rectangle(IDS.target, 500, 100),
    kind: "ellipse",
    pivot: { x: 600, y: 150 },
  };
}

function maximumStroke(index: number): StrokeElementV1 {
  const points = Array.from({ length: 4_096 }, (_, point) => [
    10 + (point % 1_000),
    10 + index,
    0.5,
  ]).flat();
  return {
    ...indexedStroke(index),
    points,
  };
}

function largeMoveSession(pointer: { readonly x: number; readonly y: number }) {
  const strokes = Array.from({ length: 1_001 }, (_, index) => indexedStroke(index));
  const session = new SelectionHandleSession({
    action: { kind: "move" },
    elements: strokes,
    planner: new ElementStore(strokes),
    startPointer: { x: 0, y: 0 },
  });
  session.update(pointer);
  return session;
}

function snapPorts(store: ElementStore) {
  const storeScratch = new SpatialQueryScratch<string>();
  return {
    pointerType: "mouse" as const,
    spatial: {
      query: (bounds: Parameters<ElementStore["query"]>[0], sink: SpatialCandidateSink) =>
        queryStore(store, bounds, storeScratch, sink),
    },
    targets: {
      get: (id: string) => {
        const anchors = store.getSemanticAnchors(id);
        const rank = store.getRank(id);
        return anchors === null || rank === undefined ? null : { anchors, rank: rank.rank };
      },
    },
    zoom: 1,
  };
}

function queryStore(
  store: ElementStore,
  bounds: Parameters<ElementStore["query"]>[0],
  scratch: SpatialQueryScratch<string>,
  sink: SpatialCandidateSink,
): void {
  const count = store.query(bounds, scratch);
  for (let index = 0; index < count; index += 1) sink.add(scratch.at(index));
}

describe("SelectionHandleSession", () => {
  it("previews and commits a target move with dependent reorientation through the reverse map", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    store.resetInstrumentation();
    const session = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [element(store, target.id)],
      planner: store,
      startPointer: { x: 100, y: 100 },
    });

    const preview = session.update({ x: 150, y: 120 });
    const previewLine = preview.exactElements.find(({ id }) => id === line.id);
    expect(preview.transform).toEqual({ delta: { x: 50, y: 20 }, kind: "translate" });
    expect(previewLine?.kind).toBe("line");
    if (previewLine?.kind !== "line") throw new Error("Expected a line preview.");
    expect(previewLine.start).toEqual({ x: 150, y: 120 });
    expect(store.instrumentation).toMatchObject({ fullStoreScans: 0, reverseDependencyVisits: 1 });

    const prepared = session.prepareCommit();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected a prepared commit.");
    expect(prepared.replacements.map(({ id }) => id)).toEqual([target.id]);
    store.replaceMany(prepared.replacements);
    expect((element(store, line.id) as LineElementV1).start).toEqual({ x: 150, y: 120 });
  });

  it("attaches to an ellipse cardinal anchor and detaches on a later free endpoint drag", () => {
    const target = ellipse();
    const line = freeLine();
    const store = new ElementStore([target, line]);
    const attach = new SelectionHandleSession({
      action: { elementId: line.id, endpoint: "end", kind: "linear-endpoint" },
      elements: [element(store, line.id)],
      planner: store,
      snap: snapPorts(store),
      startPointer: line.end,
    });

    const preview = attach.update({ x: 700, y: 150 });
    expect(preview.snapCandidate).toMatchObject({
      anchor: { angle: 0, kind: "ellipse-cardinal" },
      point: { x: 700, y: 150 },
      targetId: target.id,
    });
    const attachment = attach.prepareCommit();
    if (attachment.status !== "ready") throw new Error("Expected an attachment commit.");
    store.replaceMany(attachment.replacements);
    expect((element(store, line.id) as LineElementV1).endConnection).toEqual({
      anchor: { angle: 0, kind: "ellipse-cardinal" },
      targetId: target.id,
    });

    const detach = new SelectionHandleSession({
      action: { elementId: line.id, endpoint: "end", kind: "linear-endpoint" },
      elements: [element(store, line.id)],
      planner: store,
      snap: snapPorts(store),
      startPointer: { x: 700, y: 150 },
    });
    detach.update({ x: 760, y: 220 });
    const detachment = detach.prepareCommit();
    if (detachment.status !== "ready") throw new Error("Expected a detachment commit.");
    store.replaceMany(detachment.replacements);
    expect((element(store, line.id) as LineElementV1).endConnection).toBeNull();
    expect((element(store, line.id) as LineElementV1).end).toEqual({ x: 760, y: 220 });
  });
});

describe("SelectionHandleSession geometry boundaries", () => {
  it("collapses endpoints and scale handles to zero without mirroring", () => {
    const line = freeLine();
    const lineStore = new ElementStore([line]);
    const endpoint = new SelectionHandleSession({
      action: { elementId: line.id, endpoint: "end", kind: "linear-endpoint" },
      elements: [element(lineStore, line.id)],
      planner: lineStore,
      startPointer: line.end,
    });
    endpoint.update(line.start);
    const lineCommit = endpoint.prepareCommit();
    if (lineCommit.status !== "ready") throw new Error("Expected a clamped line commit.");
    const changedLine = lineCommit.replacements[0] as LineElementV1;
    expect(
      Math.hypot(changedLine.end.x - changedLine.start.x, changedLine.end.y - changedLine.start.y),
    ).toBe(0);

    const shape = rectangle();
    const shapeStore = new ElementStore([shape]);
    const resize = new SelectionHandleSession({
      action: {
        anchor: { x: 100, y: 150 },
        kind: "scale",
        position: "middle-right",
        rotation: 0,
      },
      elements: [element(shapeStore, shape.id)],
      planner: shapeStore,
      startPointer: { x: 300, y: 150 },
    });
    resize.update({ x: 50, y: 150 });
    const shapeCommit = resize.prepareCommit();
    if (shapeCommit.status !== "ready") throw new Error("Expected a clamped shape commit.");
    expect(shapeCommit.replacements[0]).toMatchObject({ width: 0, x: 100 });
  });

  it("rotates a target and resolves its dependent endpoint in the same preview", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const { pivot, rotation } = target;
    const session = new SelectionHandleSession({
      action: { center: pivot, kind: "rotate", opposite: pivot, referenceRotation: rotation },
      elements: [element(store, target.id)],
      planner: store,
      startPointer: { x: 300, y: 150 },
    });

    const preview = session.update({ x: 200, y: 250 });
    const changedTarget = preview.exactElements.find(({ id }) => id === target.id);
    const changedLine = preview.exactElements.find(({ id }) => id === line.id);
    expect(changedTarget?.rotation).toBe(90);
    expect(changedLine?.kind).toBe("line");
    if (changedLine?.kind !== "line") throw new Error("Expected a dependent line.");
    expect(changedLine.start).toEqual({ x: 250, y: 50 });
  });
});

describe("SelectionHandleSession viewport overflow", () => {
  it("preserves an outside-viewport move before replacement planning", () => {
    const shape = rectangle();
    const store = new ElementStore([shape]);
    const session = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [shape],
      planner: store,
      startPointer: shape.pivot,
    });

    const preview = session.update({ x: -1_000, y: -1_000 });
    expect(preview.exactElements).toHaveLength(1);
    expect(calculateElementBounds(preview.exactElements[0]!).minX).toBe(-1_102);
    expect(calculateElementBounds(preview.exactElements[0]!).minY).toBe(-1_052);

    const prepared = session.prepareCommit();
    if (prepared.status !== "ready") throw new Error("Expected an exact move commit.");
    expect(calculateElementBounds(prepared.replacements[0]!).minX).toBe(-1_102);
    expect(calculateElementBounds(prepared.replacements[0]!).minY).toBe(-1_052);
  });

  it("accepts a scaled selection wider than the viewport", () => {
    const shape = rectangle();
    const store = new ElementStore([shape]);
    const session = new SelectionHandleSession({
      action: {
        anchor: { x: 100, y: 100 },
        kind: "scale",
        position: "bottom-right",
        rotation: 0,
      },
      elements: [shape],
      planner: store,
      startPointer: { x: 300, y: 200 },
    });

    expect(session.update({ x: 3_000, y: 200 }).exactElements).toHaveLength(1);
    expect(session.prepareCommit()).toMatchObject({ status: "ready" });
    expect(element(store, shape.id)).toEqual(shape);
  });
});

describe("SelectionHandleSession coordinate handles", () => {
  it("edits coordinate origin and axes through their named handles", () => {
    const system = coordinateSystem();
    const store = new ElementStore([system]);
    const axis = new SelectionHandleSession({
      action: { axisIndex: 0, elementId: system.id, kind: "coordinate-axis" },
      elements: [element(store, system.id)],
      planner: store,
      startPointer: system.axes[0],
    });
    axis.update(system.origin);
    const axisCommit = axis.prepareCommit();
    if (axisCommit.status !== "ready") throw new Error("Expected an axis commit.");
    const changedSystem = axisCommit.replacements[0];
    expect(changedSystem?.kind).toBe("coordinate-system");
    if (changedSystem?.kind !== "coordinate-system") throw new Error("Expected a system.");
    expect(changedSystem.axes[0]).toEqual(system.origin);
    store.replaceMany(axisCommit.replacements);

    const origin = new SelectionHandleSession({
      action: { elementId: system.id, kind: "coordinate-origin" },
      elements: [element(store, system.id)],
      planner: store,
      startPointer: system.origin,
    });
    origin.update({ x: 250, y: 250 });
    const originCommit = origin.prepareCommit();
    if (originCommit.status !== "ready") throw new Error("Expected an origin commit.");
    expect(originCommit.replacements[0]).toMatchObject({
      origin: { x: 250, y: 250 },
      pivot: { x: 250, y: 250 },
    });
  });
});

describe("SelectionHandleSession lifecycle", () => {
  it("includes near-maximum document endpoint work in preview and commit budgets", async () => {
    const target = rectangle();
    const planReplacements = vi.fn(replacementPlan);
    const countReverseDependencies = vi.fn(() => 19_968);
    const session = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [target],
      planner: {
        countReverseDependencies,
        planReplacements,
        planReplacementsTimeSliced: async (replacements) => replacementPlan(replacements),
      },
      startPointer: target.pivot,
    });

    expect(session.update({ x: target.pivot.x + 10, y: target.pivot.y + 20 })).toMatchObject({
      exactElements: [],
      exactPreviewTruncated: true,
      transform: { delta: { x: 10, y: 20 }, kind: "translate" },
    });
    expect(planReplacements).not.toHaveBeenCalled();
    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
    expect(countReverseDependencies).toHaveBeenCalledWith([target.id], 255);
    await expect(
      session.prepareCommitTimeSliced({
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("time-slices exact commits when aggregate stroke work exceeds the synchronous budget", async () => {
    const strokes = Array.from({ length: 5 }, (_, index) => maximumStroke(index));
    let planned = 0;
    const session = new SelectionHandleSession({
      action: { kind: "move" },
      elements: strokes,
      planner: {
        countReverseDependencies: () => 0,
        planReplacements: (replacements) => {
          planned += 1;
          return replacementPlan(replacements);
        },
        planReplacementsTimeSliced: async (replacements) => replacementPlan(replacements),
      },
      startPointer: { x: 0, y: 0 },
    });

    expect(session.update({ x: 5, y: 7 })).toMatchObject({
      exactElements: [],
      exactPreviewTruncated: true,
      transform: { delta: { x: 5, y: 7 }, kind: "translate" },
    });
    expect(planned).toBe(0);

    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
    const prepared = await session.prepareCommitTimeSliced({
      shouldYield: () => true,
      yieldControl: async () => undefined,
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("Expected an exact time-sliced commit.");
    const replacement = prepared.replacements[0];
    if (replacement?.kind !== "stroke") throw new Error("Expected a stroke replacement.");
    expect(replacement.points.slice(0, 3)).toEqual([15, 17, 0.5]);
    expect(prepared.replacements).toHaveLength(strokes.length);
    expect(planned).toBe(0);
  });

  it("keeps cancel and no-op gestures free of prepared mutations", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const noOp = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [element(store, target.id)],
      planner: store,
      startPointer: { x: 100, y: 100 },
    });
    expect(noOp.prepareCommit()).toEqual({ status: "noop" });

    const cancelled = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [element(store, target.id)],
      planner: store,
      startPointer: { x: 100, y: 100 },
    });
    cancelled.update({ x: 120, y: 120 });
    cancelled.cancel();
    expect(cancelled.preview).toMatchObject({ exactElements: [], transform: null });
    expect(() => cancelled.prepareCommit()).toThrow(/cancelled/);
    expect(element(store, target.id)).toEqual(target);
  });
});

describe("SelectionHandleSession asynchronous lifecycle", () => {
  it("requires and supports cancellable time-sliced materialization above 1,000 elements", async () => {
    const session = largeMoveSession({ x: 5, y: 7 });

    expect(session.preview).toMatchObject({ exactElements: [], exactPreviewTruncated: true });
    expect(session.prepareCommit()).toEqual({ status: "time-sliced-required" });
    let yields = 0;
    const prepared = await session.prepareCommitTimeSliced({
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
      },
    });
    expect(prepared.status).toBe("ready");
    expect(yields).toBe(1_001);

    const cancelled = await session.prepareCommitTimeSliced({
      isCancelled: () => true,
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });
    expect(cancelled).toEqual({ status: "cancelled" });
  });

  it("preserves time-sliced materialization outside the viewport", async () => {
    const session = largeMoveSession({ x: -100, y: -100 });

    const prepared = await session.prepareCommitTimeSliced({
      shouldYield: () => false,
      yieldControl: async () => undefined,
    });

    if (prepared.status !== "ready") throw new Error("Expected exact replacements.");
    const bounds = prepared.replacements.map(calculateElementBounds);
    expect(Math.min(...bounds.map(({ minX }) => minX))).toBe(-81);
    expect(Math.min(...bounds.map(({ minY }) => minY))).toBe(-81);
  });

  it("cancels a preparation changed during its final yield", async () => {
    const target = rectangle();
    const session = new SelectionHandleSession({
      action: { kind: "move" },
      elements: [target],
      planner: {
        countReverseDependencies: () => 20_000,
        planReplacements: replacementPlan,
        planReplacementsTimeSliced: async (replacements) => replacementPlan(replacements),
      },
      startPointer: target.pivot,
    });
    session.update({ x: target.pivot.x + 10, y: target.pivot.y });

    const prepared = await session.prepareCommitTimeSliced({
      shouldYield: () => true,
      yieldControl: async () => {
        session.update({ x: target.pivot.x + 20, y: target.pivot.y });
      },
    });

    expect(prepared).toEqual({ status: "cancelled" });
  });
});
