import { describe, expect, it, vi } from "vitest";

import {
  calculateElementBounds,
  defaultTableHeaderHeight,
  rotatePointClockwise,
} from "../../../../src/domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../../src/domain/schema/public";
import { mutableElement } from "../../../../src/domain/store/immutability";
import { ElementStore } from "../../../../src/domain/store/public";
import { type ImmutableInkElement } from "../../../../src/domain/store/types";
import { layoutSelectionHandles } from "../../../../src/editor/selection/public";
import { ActiveEditorHandleInteraction } from "../../../../src/obsidian/embeds/active-editor/handle-interaction";
import type { PreparedElementHistory } from "../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { createSynchronousActiveEditorHistory } from "../../../fixtures/obsidian/synchronous-active-editor-history";
import { table as geometryTable } from "../../../unit/domain/geometry/fixtures";

describe("active editor table structure handles", () => {
  it("moves a rotated header in local coordinates and snaps back to its standard height", () => {
    const table = rotatedTable();
    const fixture = tableHarness(table);
    const start = pointer(tableHandle(table, "table-header"), 11);
    const custom = worldPoint(table, {
      x: table.x + (table.columns * table.columnWidth) / 2,
      y: table.y + 42,
    });

    previewTableDrag(fixture.interaction, start, custom);
    expect(latestTable(fixture.previews, table.id)).toMatchObject({ headerHeight: 42 });
    expect(fixture.interaction.pointerUp(start.pointerId)).toBe(true);
    const changed = requireTable(fixture.store.get(table.id)?.element);
    expect(changed.headerHeight).toBe(42);

    const standard = defaultTableHeaderHeight(changed.height);
    const standardStart = pointer(tableHandle(changed, "table-header"), 12);
    const nearStandard = worldPoint(changed, {
      x: changed.x + (changed.columns * changed.columnWidth) / 2,
      y: changed.y + standard + 2,
    });
    previewTableDrag(fixture.interaction, standardStart, nearStandard);
    expect(latestTable(fixture.previews, table.id)).toMatchObject({ headerHeight: standard });
    expect(fixture.overlays[fixture.overlays.length - 1]).toContain("M 225 -14 L 225 314");
    expect(fixture.interaction.pointerUp(standardStart.pointerId)).toBe(true);
    expect(requireTable(fixture.store.get(table.id)?.element).headerHeight).toBe(standard);
  });

  it("moves a rotated inner separator in local coordinates and snaps to equal columns", () => {
    const table = rotatedTable();
    const fixture = tableHarness(table, lowerExtentPeers());
    const originalMaximumBottom = fixture.store.getMaximumBottom();
    const start = pointer(tableHandle(table, "table-column"), 13);
    const custom = worldPoint(table, {
      x: table.x + 130,
      y: table.y + table.height / 2,
    });

    previewTableDrag(fixture.interaction, start, custom);
    expect(latestTable(fixture.previews, table.id)).toMatchObject({ columnOffsets: [130] });
    expect(fixture.interaction.pointerUp(start.pointerId)).toBe(true);
    const changed = requireTable(fixture.store.get(table.id)?.element);
    expect(changed.columnOffsets).toEqual([130]);
    expect(fixture.store.getMaximumBottom()).toBe(originalMaximumBottom);

    const standardStart = pointer(tableHandle(changed, "table-column"), 14);
    const nearStandard = worldPoint(changed, {
      x: changed.x + changed.columnWidth + 2,
      y: changed.y + changed.height / 2,
    });
    previewTableDrag(fixture.interaction, standardStart, nearStandard);
    expect(latestTable(fixture.previews, table.id)).not.toHaveProperty("columnOffsets");
    expect(fixture.overlays[fixture.overlays.length - 1]).toContain("M 314 150 L 86 150");
    expect(fixture.interaction.pointerUp(standardStart.pointerId)).toBe(true);
    expect(fixture.store.get(table.id)?.element).not.toHaveProperty("columnOffsets");
  });
});

describe("active editor table boundary handles", () => {
  it("commits header and column separators at the outer bounds", () => {
    const initial = rotatedTable();
    const headerFixture = tableHarness(initial);
    const headerStart = pointer(tableHandle(initial, "table-header"), 15);
    const belowBottom = worldPoint(initial, {
      x: initial.x + (initial.columns * initial.columnWidth) / 2,
      y: initial.y + initial.height + 50,
    });

    previewTableDrag(headerFixture.interaction, headerStart, belowBottom);
    expect(latestTable(headerFixture.previews, initial.id).headerHeight).toBe(initial.height);
    expect(headerFixture.interaction.pointerUp(headerStart.pointerId)).toBe(true);
    expect(requireTable(headerFixture.store.get(initial.id)?.element).headerHeight).toBe(
      initial.height,
    );

    const changed = requireTable(headerFixture.store.get(initial.id)?.element);
    const columnFixture = tableHarness(changed);
    const columnStart = pointer(tableHandle(changed, "table-column"), 16);
    const beyondRight = worldPoint(changed, {
      x: changed.x + changed.columns * changed.columnWidth + 50,
      y: changed.y + changed.height / 2,
    });
    previewTableDrag(columnFixture.interaction, columnStart, beyondRight);
    expect(latestTable(columnFixture.previews, changed.id).columnOffsets).toEqual([200]);
    expect(columnFixture.interaction.pointerUp(columnStart.pointerId)).toBe(true);
    expect(requireTable(columnFixture.store.get(changed.id)?.element).columnOffsets).toEqual([200]);
  });

  it("lets a separator cross its peers while storing sorted offsets", () => {
    const table = {
      ...rotatedTable(),
      columns: 3,
      pivot: { x: 250, y: 150 },
    };
    const fixture = tableHarness(table);
    const start = pointer(tableHandle(table, "table-column"), 17);
    const beyondRight = worldPoint(table, {
      x: table.x + table.columns * table.columnWidth + 50,
      y: table.y + table.height / 2,
    });

    previewTableDrag(fixture.interaction, start, beyondRight);
    expect(latestTable(fixture.previews, table.id).columnOffsets).toEqual([200, 300]);
    expect(fixture.interaction.pointerUp(start.pointerId)).toBe(true);
    expect(requireTable(fixture.store.get(table.id)?.element).columnOffsets).toEqual([200, 300]);
  });
});

function rotatedTable(): Extract<InkElementV1, { kind: "table" }> {
  const base = geometryTable();
  return {
    ...base,
    columnWidth: 100,
    columns: 2,
    headerHeight: 24,
    height: 100,
    id: "00000000-0000-4000-8000-000000000004",
    pivot: { x: 200, y: 150 },
    rotation: 90,
    x: 100,
    y: 100,
  };
}

function tableHarness(
  table: Extract<InkElementV1, { kind: "table" }>,
  additionalElements: readonly InkElementV1[] = [],
) {
  const store = new ElementStore([table, ...additionalElements]);
  const history = createSynchronousActiveEditorHistory(store);
  const overlays: Array<string | null> = [];
  const previews: InkElementV1[][] = [];
  const model = {
    mutationAvailability: "available",
    replaceElements: (elements: readonly InkElementV1[]) => store.replaceMany(elements),
    setGestureActive: vi.fn(),
    store,
  } as unknown as EditableDocumentModel;
  const interaction = new ActiveEditorHandleInteraction({
    history,
    model,
    pageToScreen: (point) => point,
    preparedHistory: {} as PreparedElementHistory,
    renderer: {
      clearElementPreviews: () => previews.push([]),
      clearPreviewTransforms: vi.fn(),
      setElementPreviews: (elements: readonly InkElementV1[]) => previews.push([...elements]),
      setSelectionOverlayPath: (path: string | null) => overlays.push(path),
      setSnapMarkerPath: (path: string | null) => overlays.push(path),
      setPreviewTransform: vi.fn(),
      suppressMotionForNextDelta: vi.fn(),
    },
    sceneStore: new ElementSceneStore(store),
    selection: () => new Set([table.id]),
    zoom: () => 1,
  });
  return { interaction, overlays, previews, store };
}

function lowerExtentPeers(): readonly InkElementV1[] {
  return [
    geometryTable({
      id: "00000000-0000-4000-8000-000000000005",
      pivot: { x: 75, y: -150 },
      x: 0,
      y: -200,
    }),
    geometryTable({
      id: "00000000-0000-4000-8000-000000000006",
      pivot: { x: 75, y: 50 },
      x: 0,
      y: 0,
    }),
  ];
}

function tableHandle(
  table: Extract<InkElementV1, { kind: "table" }>,
  kind: "table-header" | "table-column",
): PointV1 {
  const handle = layoutSelectionHandles(
    [{ bounds: calculateElementBounds(table), element: table }],
    { zoom: 1 },
  ).find((candidate) => candidate.kind === kind);
  if (handle?.kind !== kind) throw new TypeError(`Expected a ${kind} handle.`);
  return handle.point;
}

function latestTable(
  previews: readonly (readonly InkElementV1[])[],
  id: string,
): Extract<InkElementV1, { kind: "table" }> {
  const element = previews[previews.length - 1]?.find((candidate) => candidate.id === id);
  return requireTable(element);
}

function requireTable(
  element: ImmutableInkElement | InkElementV1 | undefined,
): Extract<InkElementV1, { kind: "table" }> {
  if (element?.kind !== "table") throw new TypeError("Expected a table.");
  return mutableElement(element) as Extract<InkElementV1, { kind: "table" }>;
}

function pointer(point: PointV1, pointerId: number) {
  return { ...point, pointerId, pointerType: "mouse" as const };
}

function previewTableDrag(
  interaction: ActiveEditorHandleInteraction,
  start: ReturnType<typeof pointer>,
  target: PointV1,
): void {
  expect(interaction.pointerDown(start)).toBe(true);
  expect(interaction.pointerMove({ ...start, ...target })).toBe(true);
}

function worldPoint(table: Extract<InkElementV1, { kind: "table" }>, localPoint: PointV1): PointV1 {
  return rotatePointClockwise(localPoint, table.pivot, table.rotation);
}
