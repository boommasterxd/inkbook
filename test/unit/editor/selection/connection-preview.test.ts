import { describe, expect, it, vi } from "vitest";

import { canonicalPoint } from "../../../../src/domain/geometry/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { ConnectedSelectionPreviewSession } from "../../../../src/editor/selection/public";
import {
  axisConnectedLine,
  coordinateSystem,
  connectedLine,
  rectangle,
} from "../../domain/store/fixtures";
import { connectionChain } from "../../../fixtures/domain/connection-chain";
import { editLinearEndpointFromWorld } from "../../../../src/editor/selection/transform/transforms";

describe("connected selection transform preview", () => {
  it("moves an unselected dependent endpoint through the reverse connection map", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);

    const session = new ConnectedSelectionPreviewSession(store, [target], new Set([target.id]));
    store.resetInstrumentation();
    const preview = session.update({
      delta: { x: 30, y: 40 },
      kind: "translate",
    });

    expect(preview.elements).toMatchObject([{ id: line.id, start: { x: 130, y: 140 } }]);
    expect(store.instrumentation.fullStoreScans).toBe(0);
    expect(store.instrumentation.reverseDependencyVisits).toBe(0);
  });

  it("keeps a selected connected endpoint pinned when its target is not selected", () => {
    const target = rectangle();
    const line = connectedLine(target);
    const companion = rectangle("00000000-0000-4000-8000-000000000099", 500, 300);
    const store = new ElementStore([target, line, companion]);
    const selectedIds = new Set([line.id, companion.id]);

    const session = new ConnectedSelectionPreviewSession(store, [line, companion], selectedIds);
    const preview = session.update({
      delta: { x: 30, y: 40 },
      kind: "translate",
    });

    expect(preview.elements).toMatchObject([
      { end: { x: 430, y: 140 }, id: line.id, start: { x: 100, y: 100 } },
    ]);
    expect(preview.selectedPreviewIds.has(line.id)).toBe(true);

    const collapsed = session.update({ delta: { x: -300, y: 0 }, kind: "translate" });
    expect(collapsed.elements).toMatchObject([{ end: line.start, id: line.id, start: line.start }]);
  });
});

it("propagates targeted endpoint edits through the prepared dependent order without store reads", () => {
  const elements = connectionChain(4);
  const selected = elements[1]!;
  const store = new ElementStore(elements);
  const session = new ConnectedSelectionPreviewSession(store, [selected], new Set([selected.id]));
  const get = vi.spyOn(store, "get");
  const visit = vi.spyOn(store, "visitDependents");
  store.resetInstrumentation();
  try {
    for (const point of [
      { x: 450, y: 180 },
      { x: 520, y: 190 },
    ]) {
      const edited = editLinearEndpointFromWorld(selected, "start", point, { connection: null });
      const preview = session.updateTargets([edited]);
      expect(preview.elements.map(({ id, start }) => ({ id, start }))).toEqual(
        elements.slice(1).map(({ id }) => ({ id, start: point })),
      );
    }
    expect(get).not.toHaveBeenCalled();
    expect(visit).not.toHaveBeenCalled();
    expect(store.instrumentation).toMatchObject({ fullStoreScans: 0, reverseDependencyVisits: 0 });
  } finally {
    vi.restoreAllMocks();
  }
});

it("preserves canonical endpoint ancestry from a rotated linear root through bent dual-connected followers", () => {
  const elements = connectionChain(5);
  const source = { ...elements[0]!, rotation: 90 };
  const worldStart = { x: 250, y: -50 };
  const roots = [
    source,
    ...elements.slice(1).map((element) => ({
      ...element,
      start: worldStart,
      end: { x: 250, y: 250 },
      endConnection: {
        targetId: source.id,
        anchor: { kind: "linear-endpoint" as const, endpoint: "end" as const },
      },
      bend: { x: 300.001, y: 150.999 },
      pivot: { x: 275.001, y: 100 },
    })),
  ];
  const store = new ElementStore(roots);
  const session = new ConnectedSelectionPreviewSession(store, [source], new Set([source.id]));
  try {
    const delta = { x: 0.001, y: -0.999 };
    const preview = session.update({ kind: "translate", delta });
    expect(preview.elements).toHaveLength(4);
    for (const element of preview.elements) {
      expect(canonicalPoint(element.start)).toEqual(
        canonicalPoint({ x: worldStart.x + delta.x, y: worldStart.y + delta.y }),
      );
      expect(canonicalPoint(element.end)).toEqual(
        canonicalPoint({ x: 250 + delta.x, y: 250 + delta.y }),
      );
      expect(element.startConnection).toEqual(
        roots.find(({ id }) => id === element.id)!.startConnection,
      );
      expect(element.endConnection).toEqual(
        roots.find(({ id }) => id === element.id)!.endConnection,
      );
    }
  } finally {
    session.dispose();
  }
});

it("propagates exact 3D-axis handle targets through transitive line endpoint ancestry", () => {
  const target = coordinateSystem();
  if (target.dimension !== "3d") throw new Error("Expected a 3D coordinate-system fixture.");
  const first = axisConnectedLine();
  const follower = {
    ...first,
    id: "00000000-0000-4000-8000-000000000099",
    startConnection: {
      targetId: first.id,
      anchor: { kind: "linear-endpoint" as const, endpoint: "start" as const },
    },
  };
  const store = new ElementStore([target, first, follower]);
  const session = new ConnectedSelectionPreviewSession(store, [target], new Set([target.id]));
  const endpoint = { x: 250.001, y: 450.999 };
  try {
    const edited = {
      ...target,
      axes: [target.axes[0], target.axes[1], endpoint] as typeof target.axes,
    };
    const preview = session.updateTargets([edited]);
    expect(preview.elements).toHaveLength(2);
    for (const element of preview.elements) expect(canonicalPoint(element.start)).toEqual(endpoint);
  } finally {
    session.dispose();
  }
});
