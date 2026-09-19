import { describe, expect, it, vi } from "vitest";

import type { LineElementV1 } from "../../../../src/domain/schema/public";
import {
  moveSelectionWithSnap,
  resolveSelectionMoveSnap,
} from "../../../../src/editor/selection/public";
import { SnapCandidateScratch } from "../../../../src/editor/snapping/snap-candidate";

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
  const result = resolveSelectionMoveSnap({
    current: null,
    elements: [element],
    pointerType: "mouse",
    rawDelta: { x: 47, y: 48 },
    scratch: new SnapCandidateScratch(),
    selectedIds: new Set(options.selectedTarget ? [LINE_ID, TARGET_ID] : [LINE_ID]),
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
    zoom: options.zoom ?? 1,
  });
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

  it.each([0, 2, 1_001])("does not query snap targets for %i moving elements", (count) => {
    const query = vi.fn();

    const result = resolveSelectionMoveSnap({
      current: null,
      elements: new Array(count).fill(line()),
      pointerType: "touch",
      rawDelta: { x: 1, y: 1 },
      scratch: new SnapCandidateScratch(),
      selectedIds: new Set([LINE_ID]),
      spatial: { query },
      targets: { get: () => null },
      zoom: 1,
    });

    expect(result).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
