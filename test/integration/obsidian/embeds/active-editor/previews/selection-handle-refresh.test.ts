import { describe, expect, it, vi } from "vitest";

import { moveSelection } from "../../../../../../src/editor/selection/transform/transforms";
import { rotatePointClockwise } from "../../../../../../src/domain/geometry/public";
import { layoutTextElement } from "../../../../../fixtures/editor/text-style";
import { textElement } from "../../../../../unit/domain/schema/fixtures";
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

function expectCenter(
  fixture: ReturnType<typeof selectionHandleRefreshFixture>,
  expected: { readonly x: number; readonly y: number },
) {
  expect(
    centers(fixture).some(
      ({ x, y }) => Math.abs(x - expected.x) < 0.00001 && Math.abs(y - expected.y) < 0.00001,
    ),
  ).toBe(true);
}

describe("temporary native source geometry", () => {
  it("keeps source expansion handles interactive without saving the source height", async () => {
    const element = await layoutTextElement({ ...textElement(), source: "one" });
    const fixture = selectionHandleRefreshFixture([element]);
    const saved = fixture.store.get(element.id)!.element;
    const revision = fixture.model.revision;
    const originalHeight = element.height;
    fixture.interaction.setTextEditingHeight(element.id, originalHeight + 300);
    const down = {
      x: element.x + element.width,
      y: element.y + originalHeight + 300,
      pointerId: 7,
      pointerType: "mouse" as const,
    };
    const handle = fixture.interaction.hitHandle(down, true)!;
    expect(handle).toMatchObject({ kind: "scale", position: "bottom-right" });
    expectCenter(fixture, down);
    fixture.interaction.renderCameraSelection();
    expectCenter(fixture, down);
    fixture.interaction.setTextEditingHeight(element.id, originalHeight + 150);
    expectCenter(fixture, { x: down.x, y: down.y - 150 });
    const renders = fixture.renderer.setSelectionOverlayPath.mock.calls.length;
    fixture.interaction.setTextEditingHeight(element.id, originalHeight + 150);
    fixture.interaction.setTextEditingHeight(element.id, NaN);
    fixture.interaction.setTextEditingHeight("other", undefined);
    expect(fixture.renderer.setSelectionOverlayPath).toHaveBeenCalledTimes(renders);
    expect(fixture.store.get(element.id)!.element).toBe(saved);
    expect(fixture.model.revision).toBe(revision);
    expect(fixture.history.commandCount).toBe(0);
    fixture.interaction.setTextEditingHeight(element.id, undefined);
    expect(centers(fixture)).toContainEqual({ x: down.x, y: element.y + originalHeight });
    expect(fixture.interaction.pointerDown(down, false, false, handle)).toBe(true);
    fixture.interaction.pointerMove({ ...down, x: down.x + 100 });
    fixture.interaction.pointerUp(down.pointerId);
    await vi.waitFor(() => expect(fixture.history.commandCount).toBe(1));
    const canonical = selectionHandleRefreshFixture([element]);
    const canonicalDown = { ...down, y: element.y + originalHeight };
    expect(canonical.interaction.pointerDown(canonicalDown)).toBe(true);
    canonical.interaction.pointerMove({ ...canonicalDown, x: canonicalDown.x + 100 });
    canonical.interaction.pointerUp(canonicalDown.pointerId);
    await vi.waitFor(() => expect(canonical.history.commandCount).toBe(1));
    expect(fixture.store.get(element.id)!.element).toEqual(
      canonical.store.get(element.id)!.element,
    );
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.store.get(element.id)!.element).toEqual(saved);
  });

  it("rotates source extent handles around the unchanged document pivot and restores them", async () => {
    const element = { ...(await layoutTextElement(textElement())), rotation: 30 };
    const fixture = selectionHandleRefreshFixture([element]);
    const height = element.height + 200;
    const bottom = rotatePointClockwise(
      { x: element.x + element.width, y: element.y + height },
      element.pivot,
      element.rotation,
    );
    fixture.interaction.setTextEditingHeight(element.id, height);
    expect(
      fixture.interaction.hitHandle({ ...bottom, pointerId: 1, pointerType: "mouse" }, true),
    ).toMatchObject({ kind: "scale", position: "bottom-right" });
    fixture.interaction.renderCameraSelection();
    const center = centers(fixture).find(
      (point) => Math.abs(point.x - bottom.x) < 0.01 && Math.abs(point.y - bottom.y) < 0.01,
    );
    expect(center).toBeDefined();
    fixture.interaction.setTextEditingHeight(element.id, element.height - 1);
    fixture.interaction.renderSelection();
    expect(centers(fixture)).not.toContainEqual(center);
    expect(fixture.store.get(element.id)!.element).toMatchObject({
      height: element.height,
      pivot: element.pivot,
      rotation: element.rotation,
    });
    expect(fixture.history.commandCount).toBe(0);
  });
});

describe("selected native geometry refresh", () => {
  it("retains handle identity when pending source wrapping moves the handle before resize starts", async () => {
    const element = await layoutTextElement({ ...textElement(), source: "one" });
    const fixture = selectionHandleRefreshFixture([element]);
    const down = {
      x: element.x + element.width + 2,
      y: element.y + element.height / 2,
      pointerId: 7,
      pointerType: "mouse" as const,
    };
    const handle = fixture.interaction.hitHandle(down)!;
    expect(handle).toMatchObject({ kind: "scale", position: "middle-right" });
    const wrapped = await layoutTextElement({
      ...element,
      source: "one two three four ".repeat(8),
    });
    fixture.store.replaceMany([wrapped]);
    expect(fixture.interaction.hitHandle(down)).toMatchObject({ position: "top-right" });
    expect(fixture.interaction.pointerDown(down, false, false, handle)).toBe(true);
    fixture.interaction.pointerMove({ ...down, x: down.x + 160 });
    fixture.interaction.pointerUp(down.pointerId);
    await vi.waitFor(() => expect(fixture.history.commandCount).toBe(1));
    expect(fixture.store.get(element.id)?.element).toMatchObject({
      width: element.width + 160,
      source: wrapped.source,
      style: wrapped.style,
    });
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.store.get(element.id)?.element).toEqual(wrapped);
  });

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
