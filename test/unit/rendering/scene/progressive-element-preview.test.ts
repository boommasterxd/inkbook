import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import type { SceneContentRenderer } from "../../../../src/rendering/scene/content-renderer";
import { ProgressiveElementPreview } from "../../../../src/rendering/scene/progressive-element-preview";
import { indexedStroke } from "../../../fixtures/editor/stroke";

function setup(maximumBytes?: number) {
  const content = {
    applyCanonicalElementPreview: vi.fn((_element: InkElementV1) => true),
    clearElementPreview: vi.fn(),
    promoteVisible: vi.fn(),
  };
  return {
    content,
    preview: new ProgressiveElementPreview(
      content as unknown as SceneContentRenderer,
      maximumBytes,
    ),
  };
}

function longStroke(index: number) {
  return {
    ...indexedStroke(index),
    points: Array.from({ length: 4096 }, (_, offset) => [offset, offset % 2, 0.5]).flat(),
  };
}

describe("progressive element preview lifecycle", () => {
  it.each([false, true])(
    "separates long-stroke allocation, canonical publication, and the next snapshot (pressure=%s)",
    (pressureEnabled) => {
      const { content, preview } = setup();
      const elements = [longStroke(1), longStroke(2)].map((element) => ({
        ...element,
        points: element.points.slice(0, 300 * 3),
        style: { ...element.style, pressureEnabled },
      }));
      const materialize = vi.fn((id: string) => elements.find((element) => element.id === id));
      preview.set({ ids: elements.map(({ id }) => id), materialize, version: 1 });
      expect(preview.write(100, () => 0)).toBe(true);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(content.applyCanonicalElementPreview).not.toHaveBeenCalled();
      expect(preview.write(100, () => 0)).toBe(true);
      expect(materialize).toHaveBeenCalledTimes(1);
      expect(content.applyCanonicalElementPreview).toHaveBeenCalledOnce();
      expect(preview.write(100, () => 0)).toBe(true);
      expect(materialize).toHaveBeenCalledTimes(2);
      expect(content.applyCanonicalElementPreview).toHaveBeenCalledOnce();
      expect(preview.write(100, () => 0)).toBe(false);
      expect(content.applyCanonicalElementPreview).toHaveBeenCalledTimes(2);
    },
  );

  it("defers bounded canonical work and never mounts a partially built pressure path", () => {
    const { content, preview } = setup();
    const element = longStroke(1);
    const materialize = vi.fn(() => element);
    preview.set({ ids: [element.id], materialize, version: 1 });
    expect(materialize).not.toHaveBeenCalled();
    expect(preview.write(100, () => 0)).toBe(true);
    expect(content.applyCanonicalElementPreview).not.toHaveBeenCalled();
    let frames = 1;
    while (preview.write(100, () => 0)) frames += 1;
    expect(frames).toBeGreaterThan(3);
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledOnce();
    expect(preview.values.get(element.id)).toBe(element);
    preview.applyMounted([element.id, "missing"]);
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledTimes(2);
  });

  it("finishes a started snapshot, coalesces new input, and fairly advances to other IDs", () => {
    const { content, preview } = setup();
    const elements = [longStroke(1), longStroke(2)];
    const ids = elements.map(({ id }) => id);
    preview.set({
      ids,
      materialize: (id) => elements.find((element) => element.id === id),
      version: 1,
    });
    writeOneStep(preview);
    for (let version = 2; version < 150; version += 1) {
      preview.set({
        ids,
        materialize: (id) => elements.find((element) => element.id === id),
        version,
      });
      writeOneStep(preview);
    }
    expect(content.applyCanonicalElementPreview.mock.calls.map(([element]) => element.id)).toEqual([
      ids[0],
      ids[1],
    ]);
    while (preview.write(100, () => 0)) {
      /* Complete the latest coalesced request. */
    }
    expect(preview.values.size).toBe(2);
  });

  it("cancels all pending work on clear and releases completed presentations", () => {
    const { content, preview } = setup();
    const element = startLongPreview(preview);
    preview.clear();
    expect(preview.write(100, () => 0)).toBe(false);
    expect(content.applyCanonicalElementPreview).not.toHaveBeenCalled();
    preview.set({ ids: [element.id], materialize: () => element, version: 2 });
    while (preview.write(100, () => 0)) {
      /* Complete the active request. */
    }
    preview.clear();
    expect(content.clearElementPreview).toHaveBeenCalledWith(element.id);
    expect(preview.values.size).toBe(0);
  });

  it("drops removed pending IDs and skips unavailable materializations", () => {
    const { content, preview } = setup();
    const element = startLongPreview(preview);
    preview.set({ ids: ["missing"], materialize: () => undefined, version: 2 });
    expect(preview.write(100, () => 0)).toBe(false);
    expect(content.applyCanonicalElementPreview).not.toHaveBeenCalled();
    preview.set({ ids: [element.id], materialize: () => indexedStroke(1), version: 3 });
    preview.write(100, () => 0);
    preview.set({ ids: [], materialize: () => undefined, version: 4 });
    expect(content.clearElementPreview).toHaveBeenCalledWith(element.id);
    expect(preview.write(100, () => 0)).toBe(false);
  });
});

function writeOneStep(preview: ProgressiveElementPreview): void {
  let time = 0;
  preview.write(1, () => time++);
}

function startLongPreview(preview: ProgressiveElementPreview) {
  const element = longStroke(1);
  preview.set({ ids: [element.id], materialize: () => element, version: 1 });
  writeOneStep(preview);
  return element;
}

describe("progressive preview resource bounds", () => {
  it("evicts replay geometry while preserving canonical snapshots and rebuilding evicted mounts", () => {
    const { content, preview } = setup(1);
    const elements = [indexedStroke(1), indexedStroke(2)];
    preview.set({
      ids: elements.map(({ id }) => id),
      materialize: (id) => elements.find((element) => element.id === id),
      version: 1,
    });
    while (preview.write(100, () => 0)) {
      /* Finish both canonical snapshots. */
    }
    expect(preview.memoryUsage()).toBe(
      elements.reduce((bytes, element) => bytes + 128 + element.points.length * 8, 0),
    );
    content.applyCanonicalElementPreview.mockClear();
    preview.applyMounted([elements[0]!.id]);
    expect(content.clearElementPreview).not.toHaveBeenCalled();
    while (preview.write(100, () => 0)) {
      /* Rebuild the retained snapshot after replay eviction. */
    }
    expect(content.applyCanonicalElementPreview).toHaveBeenCalledWith(
      elements[0],
      expect.any(Array),
    );
    preview.clear();
    expect(preview.memoryUsage()).toBe(0);
  });

  it("enforces the root cap at the controller boundary and accounts pending allocation", () => {
    const { preview } = setup();
    const elements = Array.from({ length: 300 }, (_, index) => indexedStroke(index));
    const materialize = vi.fn((id: string) => elements.find((element) => element.id === id));
    preview.set({ ids: elements.map(({ id }) => id), materialize, version: 1 });
    expect(preview.write(0, () => 0)).toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    while (preview.write(100, () => 0)) {
      /* Drain the bounded selection. */
    }
    expect(materialize).toHaveBeenCalledTimes(256);
    expect(preview.values.size).toBe(256);
    preview.clear();
    startLongPreview(preview);
    expect(preview.memoryUsage()).toBeGreaterThan(0);
    preview.release();
    expect(preview.memoryUsage()).toBe(0);
  });
});
