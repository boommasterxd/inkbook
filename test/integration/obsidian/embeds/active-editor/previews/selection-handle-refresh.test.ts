import { describe, expect, it } from "vitest";

import { moveSelection } from "../../../../../../src/editor/selection/transform/transforms";
import {
  selectionHandleRefreshFixture,
  selectionRefreshLinear,
} from "../../../../../fixtures/obsidian/selection-handle-refresh";

function centers(fixture: ReturnType<typeof selectionHandleRefreshFixture>) {
  const path = fixture.renderer.setSelectionOverlayPath.mock.lastCall?.[2] ?? "";
  return [...path.matchAll(/M (?<x>\S+) (?<y>\S+) a/gu)].map(({ groups }) => ({
    x: Number(groups?.x) + 5,
    y: Number(groups?.y),
  }));
}

describe("selected native geometry refresh", () => {
  it.each(["line", "arrow"] as const)(
    "updates %s handles on move, undo and redo without changing selection or camera",
    (kind) => {
      const element = selectionRefreshLinear(kind);
      const fixture = selectionHandleRefreshFixture([element]);
      fixture.interaction.renderSelection();
      const original = [
        { x: 100, y: 100 },
        { x: 120, y: 400 },
        { x: 110, y: 250 },
      ];
      const translated = original.map(({ x, y }) => ({ x: x + 250, y: y + 18 }));
      expect(centers(fixture)).toEqual(original);
      fixture.history.replace([element], moveSelection([element], { x: 250, y: 18 }));
      if (fixture.scheduler.pendingCount > 0) fixture.scheduler.runNext();
      expect(centers(fixture)).toEqual(translated);
      expect(fixture.history.undo()).toBe(true);
      if (fixture.scheduler.pendingCount > 0) fixture.scheduler.runNext();
      expect(centers(fixture)).toEqual(original);
      expect(fixture.history.redo()).toBe(true);
      if (fixture.scheduler.pendingCount > 0) fixture.scheduler.runNext();
      expect(centers(fixture)).toEqual(translated);
    },
  );
});
