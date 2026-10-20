import { afterEach, expect, it, vi } from "vitest";

import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";
import type { SceneToolCursorFrameReader } from "../../../../src/rendering/scene/tool-cursor";
import { FakeNode } from "../../../unit/rendering/scene/fakes";
import { createCursorFixture, cursorState, observeWork } from "./tool-cursor-fixture";

afterEach(() => vi.restoreAllMocks());

it.each(["tool", "eraser"] as const)(
  "direct %s movement writes only retained translations",
  (kind) => {
    const { store, renderer, scheduler, root, cursor } = createCursorFixture();
    const icon = cursor.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
    let position = 0;
    const read = vi.fn<SceneToolCursorFrameReader>(() => ({
      cursor:
        kind === "tool"
          ? { ...cursorState(position, icon), y: 40 + position }
          : { kind, x: position, y: 40 + position, radius: 20 },
      system: "crosshair",
    }));
    renderer.requestToolCursorFrame(read);
    scheduler.runAll();
    read.mockClear();
    const observations = observeWork(store, root, renderer.inputSurface);
    renderer.resetInstrumentation();
    try {
      for (let sample = 1; sample <= 32; sample += 1) {
        position = sample;
        observations.write.mockClear();
        renderer.moveToolCursor(sample, 40 + sample);
        expect(observations.write).toHaveBeenCalledExactlyOnceWith(
          "transform",
          `translate(${String(sample)} ${String(40 + sample)})`,
        );
        expect(cursor.attributes.get("transform")).toBe(
          `translate(${String(sample)} ${String(40 + sample)})`,
        );
        observations.write.mockClear();
        renderer.moveToolCursor(sample, 40 + sample);
        expect(observations.write).not.toHaveBeenCalled();
      }
      for (const boundary of observations.content) expect(boundary).not.toHaveBeenCalled();
      for (const boundary of [
        observations.traversal,
        observations.append,
        observations.insert,
        observations.remove,
        observations.system,
        read,
      ])
        expect(boundary).not.toHaveBeenCalled();
      expect(scheduler.pendingCount).toBe(0);
      expect(renderer.instrumentation()).toMatchObject({
        scheduledFrames: 0,
        geometryBuilds: 0,
        contentGeometryWrites: 0,
        livePreviewUpdates: 0,
      });
      renderer.requestToolCursorFrame(read);
      scheduler.runNext();
      expect(read).toHaveBeenCalledExactlyOnceWith(false);
      expect(observations.write).not.toHaveBeenCalled();
      expect(scheduler.pendingCount).toBe(0);
    } finally {
      renderer.destroy();
    }
  },
);

it("direct cursor movement respects invalid layout and the latest hidden frame", () => {
  const { renderer, scheduler, cursor } = createCursorFixture();
  const icon = cursor.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  const read = vi.fn<SceneToolCursorFrameReader>(() => ({
    cursor: cursorState(10, icon),
    system: "crosshair",
  }));
  renderer.requestToolCursorFrame(read);
  scheduler.runAll();
  const write = vi.spyOn(FakeNode.prototype, "setAttribute");
  try {
    renderer.invalidateLayout();
    renderer.moveToolCursor(20, 40);
    expect(write).not.toHaveBeenCalled();
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
    write.mockClear();
    renderer.moveToolCursor(30, 40);
    expect(write).toHaveBeenCalledExactlyOnceWith("transform", "translate(30 40)");
    renderer.requestToolCursorFrame(() => ({ cursor: null, system: "default" }));
    write.mockClear();
    renderer.moveToolCursor(40, 40);
    expect(write).toHaveBeenCalledExactlyOnceWith("transform", "translate(40 40)");
    scheduler.runAll();
    expect(cursor.attributes.get("display")).toBe("none");
    write.mockClear();
    renderer.moveToolCursor(50, 40);
    expect(write).not.toHaveBeenCalled();
    expect(cursor.attributes.get("display")).toBe("none");
    expect(scheduler.pendingCount).toBe(0);
    renderer.requestToolCursorFrame(read);
    scheduler.runAll();
    write.mockClear();
    renderer.moveToolCursor(60, 40);
    expect(write).toHaveBeenCalledExactlyOnceWith("transform", "translate(60 40)");
    expect(cursor.attributes.get("display")).not.toBe("none");
  } finally {
    renderer.destroy();
  }
});

it("navigation feedback projects once before paint without extra scene frames", () => {
  const { store, renderer, scheduler, root, cursor } = createCursorFixture();
  const icon = cursor.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
  let position = 40;
  const read = vi.fn<SceneToolCursorFrameReader>(() => ({
    cursor: cursorState(position, icon),
    system: "crosshair",
  }));
  renderer.requestToolCursorFrame(read);
  scheduler.runAll();
  const observations = observeWork(store, root, renderer.inputSurface);
  try {
    for (const next of [60, 80, 40]) {
      position = next;
      read.mockClear();
      observations.write.mockClear();
      renderer.resetInstrumentation();
      renderer.setCamera({ x: 0, zoom: next / 40 });
      expect(scheduler.pendingCount).toBe(1);
      renderer.flushPointerFeedbackFrame(undefined, true);
      expect(read).toHaveBeenCalledExactlyOnceWith(true);
      expect(cursor.attributes.get("transform")).toBe(`translate(${String(next)} 40)`);
      expect(observations.write.mock.calls.filter(([name]) => name === "transform")).toHaveLength(
        2,
      );
      for (const boundary of observations.content) expect(boundary).not.toHaveBeenCalled();
      expect(renderer.instrumentation().scheduledFrames).toBe(1);
      expect(scheduler.pendingCount).toBe(1);
      scheduler.runAll();
      expect(read).toHaveBeenCalledTimes(1);
      for (const boundary of observations.content) boundary.mockClear();
    }
    read.mockClear();
    for (let sample = 0; sample < 8; sample += 1) renderer.flushPointerFeedbackFrame();
    expect(read).not.toHaveBeenCalled();
    expect(scheduler.pendingCount).toBe(0);
    position = 100;
    observations.write.mockClear();
    renderer.resetInstrumentation();
    for (let sample = 0; sample < 8; sample += 1) renderer.invalidateLayout();
    expect(read).not.toHaveBeenCalled();
    expect(observations.write).not.toHaveBeenCalled();
    for (const boundary of observations.content) expect(boundary).not.toHaveBeenCalled();
    expect(renderer.instrumentation().scheduledFrames).toBe(1);
    scheduler.runAll();
    expect(read).toHaveBeenCalledExactlyOnceWith(true);
    expect(cursor.attributes.get("transform")).toBe("translate(100 40)");
  } finally {
    renderer.destroy();
  }
});
