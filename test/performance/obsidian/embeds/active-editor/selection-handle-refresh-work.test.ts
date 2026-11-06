import { expect, it, onTestFinished } from "vitest";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import {
  selectionHandleRefreshFixture,
  selectionRefreshLinear,
} from "../../../../fixtures/obsidian/selection-handle-refresh";
import { observeSelectionStoreMethod } from "../../../../fixtures/obsidian/selection-store-work";

function largeFixture() {
  const line = selectionRefreshLinear();
  if (line.kind !== "line") throw new Error("Expected a native line.");
  const background = Array.from({ length: 9999 }, (_, index) => indexedStroke(index));
  const fixture = selectionHandleRefreshFixture([...background, line], [line.id]);
  fixture.interaction.renderSelection();
  fixture.renderer.setSelectionOverlayPath.mockClear();
  const read = observeSelectionStoreMethod(fixture.sceneStore, "get");
  onTestFinished(read.restore);
  return { ...fixture, line, background, read };
}

it("coalesces selected geometry changes into one local refresh in a 10,000-element store", () => {
  const fixture = largeFixture();
  for (let step = 1; step <= 8; step++) {
    fixture.store.replace(
      fixture.line.id,
      moveSelection([fixture.line], { x: step * 3, y: step })[0]!,
    );
    expect(fixture.scheduler.pendingCount).toBe(1);
    expect(fixture.read.work.calls).toBe(0);
  }
  fixture.scheduler.runNext();
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(fixture.read.work.calls).toBe(1);
  expect(fixture.renderer.setSelectionOverlayPath).toHaveBeenCalledTimes(1);
  expect(fixture.interaction.selectionGeometry()[0]?.element).toMatchObject({
    start: { x: 124, y: 108 },
  });
  fixture.store.replace(fixture.line.id, fixture.line);
  expect(fixture.scheduler.pendingCount).toBe(1);
  fixture.interaction.dispose();
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(fixture.read.work.calls).toBe(1);
});

it("skips unrelated, paint-only and order-only changes while removing stale selected handles", () => {
  const fixture = largeFixture();
  const other = fixture.background[0]!;
  fixture.store.replace(other.id, moveSelection([other], { x: 10, y: 20 })[0]!);
  fixture.store.updateStyle(fixture.line.id, { ...fixture.line.style, outlineOpacity: 0.5 });
  fixture.store.arrange(fixture.selection, "send-to-back");
  expect(fixture.scheduler.pendingCount).toBe(0);
  expect(fixture.read.work.calls).toBe(0);
  expect(fixture.renderer.setSelectionOverlayPath).not.toHaveBeenCalled();
  fixture.store.remove([fixture.line.id]);
  expect(fixture.scheduler.pendingCount).toBe(1);
  fixture.scheduler.runNext();
  expect(fixture.read.work.calls).toBe(1);
  expect(fixture.renderer.setSelectionOverlayPath).toHaveBeenLastCalledWith(null, "accent", null);
});
