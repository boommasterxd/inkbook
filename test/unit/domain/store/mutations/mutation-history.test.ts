import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_HISTORY_BYTE_LIMIT } from "../../../../../src/domain/commands/history";
import * as sampleCopy from "../../../../../src/domain/elements/runtime-sample-copy";
import { MAX_STROKE_POINTS } from "../../../../../src/domain/schema/constants";
import { prepareMutationHistory } from "../../../../../src/domain/store/mutations/mutation-history";
import { MutationPreparationScheduler } from "../../../../../src/domain/store/mutations/mutation-preparation-scheduler";
import { ElementStore } from "../../../../../src/domain/store/public";
import type {
  AppliedElementMutation,
  ElementMutation,
} from "../../../../../src/domain/store/types";
import { highlighter, IDS } from "../fixtures";

afterEach(() => vi.restoreAllMocks());

function historyFixture() {
  const original = highlighter();
  original.points = Array.from(
    { length: MAX_STROKE_POINTS * 3 },
    (_, index) => [100, 300, 0.5][index % 3]!,
  );
  const store = new ElementStore([original]);
  const source = {
    bands: { content: [], highlight: [original.id] },
    records: new Map([[original.id, store.get(original.id)!]]),
  };
  const replacement = { ...original, points: [...original.points], rotation: 90 };
  const requested: ElementMutation = {
    bands: source.bands,
    elements: [replacement],
  };
  return {
    source,
    requested,
    desired: new Map([[replacement.id, replacement]]),
    removeIds: new Set<string>(),
  };
}

function uninterruptedScheduler() {
  return new MutationPreparationScheduler({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
}

describe("mutation history private and public ownership", () => {
  it("shares frozen unchanged bands between directions without aliasing mutable source arrays", async () => {
    const state = historyFixture();
    const transition = await prepareMutationHistory(state, uninterruptedScheduler());
    if (transition === "cancelled") throw new Error("Unexpected cancellation.");
    expect(transition.reverse.bands.highlight).toBe(transition.forward.bands.highlight);
    expect(transition.reverse.bands.highlight).not.toBe(state.source.bands.highlight);
    state.source.bands.highlight.push(IDS.other);
    expect(transition.reverse.bands.highlight).toEqual([IDS.highlight]);
  });

  it("shares validated unchanged public removal bands and independently captures the changed band", async () => {
    const state = historyFixture();
    const requested = Object.freeze({
      bands: Object.freeze({ content: Object.freeze([IDS.target]), highlight: Object.freeze([]) }),
      removeIds: Object.freeze([IDS.highlight]),
    });
    const transition = await prepareMutationHistory(
      {
        ...state,
        source: { ...state.source, bands: { content: [IDS.target], highlight: [IDS.highlight] } },
        requested,
        desired: new Map(),
        removeIds: new Set([IDS.highlight]),
        dirtyBands: { content: false, highlight: true },
      },
      uninterruptedScheduler(),
      undefined,
      true,
    );
    if (transition === "cancelled") throw new Error("Unexpected cancellation.");
    expect(transition.reverse.bands.content).toBe(requested.bands.content);
    expect(transition.reverse.bands.highlight).not.toBe(requested.bands.highlight);
    expect(transition.reverse.bands.highlight).toEqual([IDS.highlight]);
  });

  it("copies each retained direction once in bounded sample ranges", async () => {
    const state = historyFixture();
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const copy = vi.spyOn(sampleCopy, "copySampleRange");
    const transition = await prepareMutationHistory(state, uninterruptedScheduler());
    expect(transition).not.toBe("cancelled");
    if (transition === "cancelled") return;
    expect(allocate).toHaveBeenCalledTimes(2);
    expect(copy).toHaveBeenCalledTimes((MAX_STROKE_POINTS / 256) * 2);
    copy.mock.calls.forEach(([, , start, end]) => expect(end - start).toBeLessThanOrEqual(256 * 3));
    const forward = transition.forward.elements?.[0];
    const reverse = transition.reverse.elements?.[0];
    if (forward?.kind !== "stroke" || reverse?.kind !== "stroke")
      throw new Error("Expected strokes.");
    expect(forward.points).not.toBe(
      state.requested.elements?.[0]?.kind === "stroke" && state.requested.elements[0].points,
    );
    const stored = state.source.records.get(IDS.highlight)!.element;
    expect(reverse.points).not.toBe(stored.kind === "stroke" && stored.points);
    forward.points[0] = 777;
    reverse.points[0] = 888;
    expect(state.desired.get(IDS.highlight)?.points[0]).toBe(100);
    expect(stored.kind === "stroke" && stored.points[0]).toBe(100);
    for (const direction of [transition.forward, transition.reverse]) {
      expect(Object.isFrozen(direction)).toBe(true);
      expect(Object.isFrozen(direction.bands)).toBe(true);
      expect(Object.isFrozen(direction.bands.highlight)).toBe(true);
      expect(Object.isFrozen(direction.elements)).toBe(true);
      expect(Object.isFrozen(direction.removeIds)).toBe(true);
    }
  });

  it("retains the trusted removal direction and clones its removed private source once", async () => {
    const fixture = historyFixture();
    const requested = { bands: { content: [], highlight: [] }, removeIds: [IDS.highlight] };
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    const transition = await prepareMutationHistory(
      { ...fixture, requested, desired: new Map(), removeIds: new Set([IDS.highlight]) },
      uninterruptedScheduler(),
      undefined,
      true,
    );
    if (transition === "cancelled") throw new Error("Unexpected cancellation.");
    expect(transition.forward).toBe(requested);
    expect(transition.reverse.elements).toHaveLength(1);
    expect(allocate).toHaveBeenCalledTimes(1);
  });
});

describe("mutation history cancellation and retention bounds", () => {
  it.each([false, true])(
    "discards incomplete sample copies in either direction (removal: %s)",
    async (removal) => {
      const fixture = historyFixture();
      const state = removal
        ? {
            ...fixture,
            requested: { bands: { content: [], highlight: [] }, removeIds: [IDS.highlight] },
            desired: new Map(),
            removeIds: new Set([IDS.highlight]),
          }
        : fixture;
      const copy = vi.spyOn(sampleCopy, "copySampleRange");
      let cancelled = false;
      const scheduler = new MutationPreparationScheduler({
        isCancelled: () => cancelled,
        shouldYield: () => copy.mock.calls.length > 0,
        yieldControl: async () => {
          cancelled = true;
        },
      });
      expect(await prepareMutationHistory(state, scheduler)).toBe("cancelled");
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copy.mock.calls[0]?.slice(2, 4)).toEqual([0, 256 * 3]);
      expect(state.source.records.get(IDS.highlight)?.element.kind).toBe("stroke");
    },
  );

  it("preserves replay identity without copying retained samples", async () => {
    const state = historyFixture();
    const replay = await prepareMutationHistory(state, uninterruptedScheduler());
    if (replay === "cancelled") throw new Error("Unexpected cancellation.");
    const allocate = vi.spyOn(sampleCopy, "allocateSampleCopy");
    expect(await prepareMutationHistory(state, uninterruptedScheduler(), replay)).toBe(replay);
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "enforces the combined public/private payload cap (replay: %s)",
    async (replaying) => {
      const requested = { bands: { content: [IDS.target], highlight: [] } };
      const replay: AppliedElementMutation = {
        forward: requested,
        reverse: requested,
        payloadBytes: 0,
      };
      const state = {
        requested,
        source: { bands: requested.bands, records: new Map() },
        desired: new Map(),
        removeIds: new Set<string>(),
        ownedPayloadBytes: DEFAULT_HISTORY_BYTE_LIMIT,
      };
      await expect(
        prepareMutationHistory(state, uninterruptedScheduler(), replaying ? replay : undefined),
      ).rejects.toThrow("retained history payload limit");
    },
  );
});
