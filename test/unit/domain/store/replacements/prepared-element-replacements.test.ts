import { describe, expect, it, vi } from "vitest";

import { UniformSpatialIndex } from "../../../../../src/domain/spatial/index";
import { DocumentCapacity } from "../../../../../src/domain/store/records/document-capacity";
import { PreparedElementReplacements } from "../../../../../src/domain/store/replacements/prepared-element-replacements";
import { createInitialRecord } from "../../../../../src/domain/store/records/record-factory";
import { ReplacementHistory } from "../../../../../src/domain/store/replacements/replacement-history";
import type { ElementReplacementPlan } from "../../../../../src/domain/store/replacements/replacement-types";
import type {
  ElementReplacementCommitResult,
  PreparedElementReplacement,
} from "../../../../../src/domain/store/types";

import { rectangle } from "../fixtures";

const SCHEDULER = { shouldYield: () => false, yieldControl: async () => undefined };

function scenario() {
  const element = rectangle();
  const record = createInitialRecord(element);
  const capacity = new DocumentCapacity();
  capacity.addInitial(record);
  const spatialIndex = new UniformSpatialIndex<string>();
  spatialIndex.insert(element.id, record.bounds);
  const source = {
    capacity,
    geometryVersion: 0,
    history: new ReplacementHistory(),
    mutationVersion: 0,
    paintVersion: 0,
    records: new Map([[element.id, record]]),
    reverseConnections: new Map(),
    spatialIndex,
  };
  const onPrepared = vi.fn<(plan: ElementReplacementPlan) => void>();
  const readSource = vi.fn(() => source);
  const onCommit = vi.fn((plan: ElementReplacementPlan): ElementReplacementCommitResult => ({
    delta: plan.delta,
    history: plan.history,
    status: "committed",
  }));
  return {
    element,
    onCommit,
    onPrepared,
    readSource,
    preparation: new PreparedElementReplacements(
      readSource,
      () => source.mutationVersion,
      onPrepared,
      onCommit,
    ),
    source,
  };
}

describe("prepared element replacement lifecycle", () => {
  it("publishes preparation accounting once and consumes each token once", async () => {
    const { element, onCommit, onPrepared, preparation, readSource } = scenario();
    const prepared = await preparation.prepare([rectangle(element.id, 200, 250)], SCHEDULER);
    expect(prepared.status).toBe("prepared");
    if (prepared.token === null) throw new Error("Expected replacement token.");
    expect(Object.isFrozen(prepared.token)).toBe(true);
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    const plan = onPrepared.mock.calls[0]![0];
    expect(prepared.historyPayloadBytes).toBe(plan.history.payloadBytes);
    expect(prepared.historyPayloadBytes).toBeGreaterThan(0);
    expect(Object.keys(prepared).sort()).toEqual(["historyPayloadBytes", "status", "token"]);
    expect(preparation.commit(prepared.token)).toEqual({
      delta: plan.delta,
      history: plan.history,
      status: "committed",
    });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(plan);
    expect(preparation.commit(prepared.token)).toEqual({
      delta: null,
      history: null,
      status: "cancelled",
    });
    const unknown = Object.freeze({}) as PreparedElementReplacement;
    expect(preparation.commit(unknown).status).toBe("cancelled");
    expect(onCommit).toHaveBeenCalledOnce();
    expect(readSource).toHaveBeenCalledOnce();
  });

  it("returns empty and equal-input no-ops without accounting or adoption", async () => {
    const { element, onCommit, onPrepared, preparation } = scenario();
    expect(await preparation.prepare([], SCHEDULER)).toEqual({ status: "noop", token: null });
    expect(await preparation.prepare([element], SCHEDULER)).toEqual({
      status: "noop",
      token: null,
    });
    expect(onPrepared).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["version", "scheduler"])("rejects %s changes after preparation", async (cause) => {
    const { element, onCommit, preparation, source } = scenario();
    let cancelled = false;
    const prepared = await preparation.prepare([rectangle(element.id, 200, 250)], {
      ...SCHEDULER,
      isCancelled: () => cancelled,
    });
    if (prepared.token === null) throw new Error("Expected replacement token.");
    if (cause === "version") source.mutationVersion += 1;
    else cancelled = true;
    expect(preparation.commit(prepared.token)).toEqual({
      delta: null,
      history: null,
      status: "cancelled",
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("cancels stale preparation during a scheduler handoff", async () => {
    const { element, onCommit, onPrepared, preparation, source } = scenario();
    const prepared = await preparation.prepare([rectangle(element.id, 200, 250)], {
      shouldYield: () => true,
      yieldControl: async () => {
        source.mutationVersion += 1;
      },
    });
    expect(prepared).toEqual({ status: "cancelled", token: null });
    expect(onPrepared).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects malformed inputs without retaining a token", async () => {
    const { element, onCommit, onPrepared, preparation } = scenario();
    await expect(
      preparation.prepare([{ ...element, width: Number.NaN }], SCHEDULER),
    ).rejects.toThrow(RangeError);
    expect(onPrepared).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
