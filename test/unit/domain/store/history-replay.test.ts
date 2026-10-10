import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HISTORY_BYTE_LIMIT } from "../../../../src/domain/commands/history";
import * as payload from "../../../../src/domain/store/mutation-payload";
import * as recordFactory from "../../../../src/domain/store/record-factory";
import {
  ElementStore,
  type AppliedElementMutation,
  type ElementMutation,
} from "../../../../src/domain/store/public";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";
import { highlighter, rectangle } from "./fixtures";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

async function removedStroke() {
  const source = highlighter();
  const { store } = await hydrateRuntimeStroke(source);
  const transition = await apply(store, {
    bands: { content: [], highlight: [] },
    removeIds: [source.id],
  });
  return { source, store, transition };
}

async function apply(
  store: ElementStore,
  mutation: ElementMutation,
  replay?: AppliedElementMutation,
) {
  const prepared = await store.prepareElementMutation(mutation, scheduler, replay);
  if (prepared.token === null) throw new Error("Expected prepared mutation.");
  const result = store.commitPreparedElementMutation(prepared.token);
  if (result.transition === null) throw new Error("Expected applied mutation.");
  return result.transition;
}

describe("owned history replay", () => {
  it.each(["prepared", "synchronous"])(
    "restores owned samples and bounds after %s removal with fresh versions",
    async (mode) => {
      const source = highlighter();
      const { store } = await hydrateRuntimeStroke(source);
      const original = store.get(source.id)!;
      const transition =
        mode === "synchronous"
          ? store.removeWithHistory([source.id])!.transition
          : await apply(store, { bands: { content: [], highlight: [] }, removeIds: [source.id] });
      const retained = transition.reverse.elements![0]!;
      expect(retained).not.toBe(original.element);
      await apply(store, transition.reverse, transition);
      const restored = store.get(source.id)!;
      expect(restored).not.toBe(original);
      expect(restored.element).toBe(original.element);
      expect(restored.bounds).toBe(original.bounds);
      expect(restored.geometryVersion).toBeGreaterThan(original.geometryVersion);
      expect(restored.paintVersion).toBeGreaterThan(original.paintVersion);
      expect(transition.payloadBytes).toBeGreaterThan(
        payload.elementMutationPayloadBytes(original.element) * 2,
      );
      await apply(store, transition.forward, transition);
      await apply(store, transition.reverse, transition);
      expect(store.get(source.id)?.element).toBe(original.element);
      expect(store.get(source.id)?.geometryVersion).toBeGreaterThan(restored.geometryVersion);
    },
  );

  it("reuses both replacement records while preserving fresh geometry and unchanged paint versions", async () => {
    const source = rectangle();
    const store = new ElementStore([source]);
    const original = store.get(source.id)!;
    const transition = await apply(store, {
      bands: { content: [source.id], highlight: [] },
      elements: [
        { ...source, x: source.x + 100, pivot: { ...source.pivot, x: source.pivot.x + 100 } },
      ],
    });
    const changed = store.get(source.id)!;
    await apply(store, transition.reverse, transition);
    expect(store.get(source.id)).toMatchObject({ geometryVersion: 2, paintVersion: 0 });
    expect(store.get(source.id)?.element).toBe(original.element);
    expect(store.get(source.id)?.bounds).toBe(original.bounds);
    await apply(store, transition.forward, transition);
    expect(store.get(source.id)).toMatchObject({ geometryVersion: 3, paintVersion: 0 });
    expect(store.get(source.id)?.element).toBe(changed.element);
    expect(store.get(source.id)?.bounds).toBe(changed.bounds);
  });

  it("rebuilds a valid changed public sample buffer without mutating the private record", async () => {
    const source = highlighter();
    const { store, points } = await hydrateRuntimeStroke(source);
    const transition = await apply(store, {
      bands: { content: [], highlight: [] },
      removeIds: [source.id],
    });
    const retained = transition.reverse.elements![0]!;
    if (retained.kind !== "stroke") throw new Error("Expected retained stroke.");
    retained.points[0] = retained.points[0]! + 10;
    const build = vi.spyOn(recordFactory, "createInitialRecord");
    try {
      await apply(store, transition.reverse, transition);
      expect(build).toHaveBeenCalledTimes(1);
      expect(points[0]).toBe(source.points[0]);
      const restored = store.get(source.id)?.element;
      if (restored?.kind !== "stroke") throw new Error("Expected restored stroke.");
      expect(restored.points).not.toBe(points);
      expect(restored.points[0]).toBe(source.points[0]! + 10);
    } finally {
      build.mockRestore();
    }
  });

  it("does not transfer private record provenance to another store", async () => {
    const { transition } = await removedStroke();
    const other = new ElementStore();
    const build = vi.spyOn(recordFactory, "createInitialRecord");
    try {
      await apply(other, transition.reverse, transition);
      expect(build).toHaveBeenCalledTimes(1);
      await apply(other, transition.forward, transition);
      await apply(other, transition.reverse, transition);
      expect(build).toHaveBeenCalledTimes(2);
    } finally {
      build.mockRestore();
    }
  });
});

describe("validated history replay", () => {
  it("checks private record retention against the payload cap before publication", async () => {
    const source = highlighter();
    const { store } = await hydrateRuntimeStroke(source);
    const estimate = vi
      .spyOn(payload, "elementMutationPayloadBytes")
      .mockReturnValue(DEFAULT_HISTORY_BYTE_LIMIT / 2);
    try {
      await expect(
        store.prepareElementMutation(
          {
            bands: { content: [], highlight: [] },
            removeIds: [source.id],
          },
          scheduler,
        ),
      ).rejects.toThrow("retained history payload limit");
      expect(store.size).toBe(1);
      expect(store.instrumentation.publishedDeltas).toBe(0);
    } finally {
      estimate.mockRestore();
    }
    const transition = await apply(store, {
      bands: { content: [], highlight: [] },
      removeIds: [source.id],
    });
    await apply(store, transition.reverse, transition);
    expect(store.size).toBe(1);
  });

  it("reuses the retained transition through Undo and Redo", async () => {
    const { store, source, transition } = await removedStroke();
    expect(await apply(store, transition.reverse, transition)).toBe(transition);
    expect(store.get(source.id)?.element).toMatchObject({
      id: source.id,
      points: new Float64Array(source.points),
    });
    expect(await apply(store, transition.forward, transition)).toBe(transition);
    expect(store.size).toBe(0);
    expect(store.instrumentation.publishedDeltas).toBe(3);
  });

  it("rejects unrelated requests paired with a replay transition", async () => {
    const { store, transition } = await removedStroke();
    await expect(
      store.prepareElementMutation({ ...transition.reverse }, scheduler, transition),
    ).rejects.toThrow("retained transition direction");
    expect(store.size).toBe(0);
  });

  it("validates retained runtime samples again before restoring them", async () => {
    const { store, transition } = await removedStroke();
    const restored = transition.reverse.elements![0]!;
    if (restored.kind !== "stroke") throw new Error("Expected stroke.");
    restored.points[0] = Number.NaN;
    await expect(
      store.prepareElementMutation(transition.reverse, scheduler, transition),
    ).rejects.toThrow(RangeError);
    expect(store.size).toBe(0);
  });

  it("rechecks payload limits instead of trusting retained metadata", async () => {
    const { store, transition } = await removedStroke();
    const estimate = vi
      .spyOn(payload, "elementMutationPayloadBytes")
      .mockReturnValue(DEFAULT_HISTORY_BYTE_LIMIT);
    try {
      await expect(
        store.prepareElementMutation(transition.reverse, scheduler, transition),
      ).rejects.toThrow("retained history payload limit");
      expect(store.size).toBe(0);
    } finally {
      estimate.mockRestore();
    }
  });

  it("cancels a replay during preparation without publication", async () => {
    const { store, transition } = await removedStroke();
    let cancelled = false;
    const result = await store.prepareElementMutation(
      transition.reverse,
      {
        isCancelled: () => cancelled,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelled = true;
        },
      },
      transition,
    );
    expect(result.status).toBe("cancelled");
    expect(store.size).toBe(0);
    expect(store.instrumentation.publishedDeltas).toBe(1);
  });
});
