import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { ConnectedSelectionPreviewSession } from "../../../../src/editor/selection/public";
import { connectedLine, rectangle } from "../../domain/store/fixtures";
import { connectionChain } from "../../../fixtures/domain/connection-chain";
import { editLinearEndpointFromWorld } from "../../../../src/editor/selection/transforms";

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
