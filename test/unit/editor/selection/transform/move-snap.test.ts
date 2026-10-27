import { describe, expect, it, vi } from "vitest";

import type { LineElementV1 } from "../../../../../src/domain/schema/public";
import { moveSelectionWithSnap } from "../../../../../src/editor/selection/public";
import { ScheduledMoveSnap } from "../../../../../src/editor/selection/transform/scheduled-move-snap";

const LINE_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "00000000-0000-4000-8000-000000000002";

function line(): LineElementV1 {
  return {
    bend: null,
    createdAt: 1,
    end: { x: 350, y: 50 },
    endConnection: null,
    endNode: "none",
    id: LINE_ID,
    kind: "line",
    pivot: { x: 200, y: 50 },
    rotation: 0,
    start: { x: 50, y: 50 },
    startConnection: null,
    startNode: "none",
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
  };
}

function resolve(
  element: LineElementV1,
  options: { readonly selectedTarget?: boolean; readonly zoom?: number } = {},
) {
  const query = vi.fn((_bounds, sink: { add(id: string): void }) => sink.add(TARGET_ID));
  const lookup = new ScheduledMoveSnap({
    element: options.selectedTarget ? undefined : element,
    canConnect: () => true,
    pointerType: "mouse",
    spatial: { query },
    targets: {
      get: () => ({
        anchors: [
          {
            anchor: { kind: "box", position: "top-left" },
            order: 0,
            point: { x: 100, y: 100 },
          },
        ],
        rank: 1,
      }),
    },
  });
  lookup.update({ x: 47, y: 48 }, null, options.zoom ?? 1, () => undefined);
  const result = lookup.value;
  lookup.cancel();
  return { query, result };
}

describe("selection move snapping", () => {
  it("snaps a free endpoint and persists the semantic connection", () => {
    const source = line();
    const { result } = resolve(source);

    expect(result).toMatchObject({
      delta: { x: 50, y: 50 },
      elementId: LINE_ID,
      endpoint: "start",
    });
    const moved = moveSelectionWithSnap([source], result!.delta, result)[0];
    expect(moved).toMatchObject({
      start: { x: 100, y: 100 },
      startConnection: {
        anchor: { kind: "box", position: "top-left" },
        targetId: TARGET_ID,
      },
    });
  });

  it("does not snap to a shape inside the moving selection", () => {
    const { query, result } = resolve(line(), { selectedTarget: true });
    expect(result).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("leaves already connected endpoints attached and narrows acquisition at high zoom", () => {
    const connected = {
      ...line(),
      startConnection: {
        anchor: { kind: "box", position: "top-left" } as const,
        targetId: TARGET_ID,
      },
    };

    expect(resolve(connected).result).toBeNull();
    expect(resolve(line(), { zoom: 4 }).result).toBeNull();
  });

  it("does not query snap targets without a single moving element", () => {
    const query = vi.fn();

    const lookup = new ScheduledMoveSnap({
      element: undefined,
      canConnect: () => true,
      pointerType: "touch",
      spatial: { query },
      targets: { get: () => null },
    });
    lookup.update({ x: 1, y: 1 }, null, 1, () => undefined);
    expect(lookup.value).toBeNull();
    expect(query).not.toHaveBeenCalled();
    lookup.cancel();
  });
});
