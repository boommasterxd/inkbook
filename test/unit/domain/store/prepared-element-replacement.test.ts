import { describe, expect, it, vi } from "vitest";

import { SpatialQueryScratch } from "../../../../src/domain/spatial/index";
import { ElementStore } from "../../../../src/domain/store/public";
import { moveSelectionTimeSliced } from "../../../../src/editor/selection/public";

import { connectedLine, highlighter, IDS, mixedElement, rectangle } from "./fixtures";

const SCHEDULER = {
  shouldYield: () => false,
  yieldControl: async () => undefined,
};

describe("ElementStore incremental prepared replacement", () => {
  it("visits only one changed index entry in a 1,024-element store", async () => {
    const elements = Array.from({ length: 1_024 }, (_, index) => mixedElement(index));
    const store = new ElementStore(elements);
    const target = elements[0]!;
    const oldRecord = store.get(target.id)!;
    const stableRecord = store.get(elements[1]!.id);
    const oldMaximumBottom = store.getMaximumBottom();
    const moved = rectangle(target.id, 500, 500);
    let yields = 0;
    const prepared = await store.prepareElementReplacement([moved], {
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
        expect(store.get(target.id)).toBe(oldRecord);
        expect(store.getMaximumBottom()).toBe(oldMaximumBottom);
        expect(queryIds(store, oldRecord.bounds)).toContain(target.id);
      },
    });
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");

    expect(yields).toBeGreaterThan(1);
    expect(store.get(elements[1]!.id)).toBe(stableRecord);
    expect(store.instrumentation.timeSlicedIndexVisits).toBe(1);
    expect(queryIds(store, oldRecord.bounds)).not.toContain(target.id);
    expect(queryIds(store, store.get(target.id)!.bounds)).toContain(target.id);
  });

  it("publishes one coherent record, index, and connection patch", async () => {
    const target = rectangle();
    const stable = rectangle(IDS.other, 700, 100);
    const line = connectedLine(target);
    const store = new ElementStore([target, stable, line]);
    const stableRecord = store.get(stable.id);
    const oldTargetRecord = store.get(target.id);
    const oldLineRecord = store.get(line.id);
    const movedTarget = rectangle(target.id, 200, 250);
    const listener = vi.fn(() => assertCoherentCommit(store, movedTarget, line.id));
    store.subscribe(listener);

    const prepared = await store.prepareElementReplacement([movedTarget], SCHEDULER);
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    expect(store.get(target.id)).toBe(oldTargetRecord);
    expect(store.get(line.id)).toBe(oldLineRecord);
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");

    expect(listener).toHaveBeenCalledOnce();
    expect(store.get(stable.id)).toBe(stableRecord);
    expect(store.get(target.id)).not.toBe(oldTargetRecord);
    expect(store.get(line.id)).not.toBe(oldLineRecord);
  });

  it("patches only reverse buckets affected by changed connection endpoints", async () => {
    const oldTarget = rectangle();
    const newTarget = rectangle(IDS.other, 700, 100);
    const line = connectedLine(oldTarget);
    const store = new ElementStore([oldTarget, newTarget, line]);
    const replacement = structuredClone(line);
    replacement.startConnection = {
      anchor: { kind: "box", position: "top-left" },
      targetId: newTarget.id,
    };
    replacement.start = { x: newTarget.x, y: newTarget.y };

    const prepared = await store.prepareElementReplacement([replacement], SCHEDULER);
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");

    expect(dependentIds(store, oldTarget.id)).toEqual([]);
    expect(dependentIds(store, newTarget.id)).toEqual([line.id]);

    expect(store.replace(line.id, line)).not.toBeNull();
    expect(dependentIds(store, oldTarget.id)).toEqual([line.id]);
    expect(dependentIds(store, newTarget.id)).toEqual([]);
  });

  it("discards a plan cancelled by its final record-preparation yield", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const original = store.get(target.id);
    let yields = 0;
    const prepared = await store.prepareElementReplacement([rectangle(target.id, 200, 250)], {
      isCancelled: () => yields === 2,
      shouldYield: () => yields < 2,
      yieldControl: async () => {
        yields += 1;
      },
    });

    expect(prepared).toEqual({ status: "cancelled", token: null });
    expect(store.get(target.id)).toBe(original);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });
});

describe("ElementStore large replacement admission", () => {
  it("prepares canonical translations across old record thresholds without forced waits", async () => {
    const strokes = Array.from({ length: 257 }, (_, index) => ({
      ...highlighter(),
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    }));
    const store = new ElementStore(strokes);
    const moved = await moveSelectionTimeSliced(strokes, { x: 1, y: 2 }, SCHEDULER);
    if (moved === null) throw new Error("Expected translated strokes.");
    let yields = 0;
    const prepared = await store.prepareElementReplacement(moved, {
      shouldYield: () => false,
      yieldControl: async () => {
        yields += 1;
      },
    });

    expect(yields).toBe(0);
    expect(prepared.token).not.toBeNull();
    if (prepared.token === null) return;
    expect(store.commitPreparedElementReplacement(prepared.token).delta?.changes).toHaveLength(
      strokes.length,
    );
  });

  it("uses remaining shared budget before atomic commit", async () => {
    const elements = Array.from({ length: 1_000 }, (_, index) =>
      rectangle(`00000000-0000-4000-8002-${index.toString().padStart(12, "0")}`),
    );
    const store = new ElementStore(elements);
    const stableRecord = store.get(elements[0]!.id);
    let yields = 0;
    const prepared = await store.prepareElementReplacement(
      elements.map((element) => rectangle(element.id, element.x + 1, element.y + 1)),
      {
        shouldYield: () => false,
        yieldControl: async () => {
          yields += 1;
          expect(store.get(elements[0]!.id)).toBe(stableRecord);
          expect(store.instrumentation.publishedDeltas).toBe(0);
        },
      },
    );

    expect(yields).toBe(0);
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
    expect(store.instrumentation.publishedDeltas).toBe(1);
  });
});

describe("ElementStore sliced reverse replacement", () => {
  it("time-slices draft, reverse propagation, and classification work", async () => {
    const scenario = reverseReplacementScenario();
    const { prepared, yields } = await prepareSlicedReplacement(scenario, {
      onYield: () => {
        expect(scenario.store.get(scenario.target.id)).toBe(scenario.beforeTarget);
        expect(scenario.store.get(scenario.lines[0]!.id)).toBe(scenario.beforeLine);
      },
    });

    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");
    expect(yields).toBeGreaterThan(1_500);
    expect(scenario.store.commitPreparedElementReplacement(prepared.token).status).toBe(
      "committed",
    );
    expect(scenario.store.get(scenario.lines[0]!.id)?.element).toMatchObject({
      start: { x: 125, y: 140 },
    });
    expect(scenario.store.instrumentation.timeSlicedIndexVisits).toBe(1_025);
  });

  it("cancels during reverse propagation without publishing partial state", async () => {
    const scenario = reverseReplacementScenario();
    const { prepared } = await prepareSlicedReplacement(scenario, { cancelAfterYields: 10 });

    expect(prepared).toEqual({ status: "cancelled", token: null });
    expect(scenario.store.get(scenario.target.id)).toBe(scenario.beforeTarget);
    expect(scenario.store.get(scenario.lines[0]!.id)).toBe(scenario.beforeLine);
    expect(scenario.store.instrumentation.publishedDeltas).toBe(0);
  });

  it("consumes a prepared token cancelled after preparation", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    let cancelled = false;
    const prepared = await store.prepareElementReplacement(
      [rectangle(target.id, target.x + 25, target.y + 40)],
      {
        isCancelled: () => cancelled,
        shouldYield: () => false,
        yieldControl: async () => undefined,
      },
    );
    if (prepared.token === null) throw new Error("Expected a prepared replacement token.");

    cancelled = true;
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("cancelled");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("cancelled");
    expect(store.get(target.id)?.element).toEqual(target);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });
});

describe("ElementStore replacement capacity", () => {
  it("rolls back the complete synchronous batch when one maximum bottom exceeds the cap", () => {
    const target = rectangle();
    const stable = rectangle(IDS.other, 700, 100);
    const line = connectedLine(target);
    const store = new ElementStore([target, stable, line]);
    const before = new Map([target, stable, line].map(({ id }) => [id, store.get(id)]));
    const oldBounds = store.get(target.id)!.bounds;
    const listener = vi.fn();
    store.subscribe(listener);
    const excessive = rectangle(stable.id, stable.x, 999_900);

    expect(() => store.replaceMany([rectangle(target.id, 200, 250), excessive])).toThrow(
      RangeError,
    );

    for (const [id, record] of before) expect(store.get(id)).toBe(record);
    expect(queryIds(store, oldBounds)).toContain(target.id);
    expect(dependentIds(store, target.id)).toEqual([line.id]);
    expect(store.getMaximumBottom()).toBeLessThan(1_000_000);
    expect(listener).not.toHaveBeenCalled();
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });
});

function assertCoherentCommit(
  store: ElementStore,
  movedTarget: ReturnType<typeof rectangle>,
  lineId: string,
): void {
  const scratch = new SpatialQueryScratch<string>();
  expect(store.get(movedTarget.id)?.element.pivot).toEqual(movedTarget.pivot);
  expect(store.get(lineId)?.element).toMatchObject({ start: { x: 200, y: 250 } });
  expect(store.query(store.get(movedTarget.id)!.bounds, scratch)).toBeGreaterThan(0);
  expect(dependentIds(store, movedTarget.id)).toEqual([lineId]);
}

function dependentIds(store: ElementStore, targetId: string): string[] {
  const dependents: string[] = [];
  store.visitDependents(targetId, ({ linearId }) => dependents.push(linearId));
  return dependents;
}

function queryIds(store: ElementStore, bounds: Parameters<ElementStore["query"]>[0]): string[] {
  const scratch = new SpatialQueryScratch<string>();
  store.query(bounds, scratch);
  return Array.from({ length: scratch.count }, (_, index) => scratch.at(index));
}

function reverseReplacementScenario() {
  const target = rectangle();
  const lines = connectedLines(target, 512);
  const store = new ElementStore([target, ...lines]);
  return {
    beforeLine: store.get(lines[0]!.id),
    beforeTarget: store.get(target.id),
    lines,
    store,
    target,
  };
}

async function prepareSlicedReplacement(
  scenario: ReturnType<typeof reverseReplacementScenario>,
  options: { readonly cancelAfterYields?: number; readonly onYield?: () => void } = {},
) {
  let yields = 0;
  const prepared = await scenario.store.prepareElementReplacement(
    [rectangle(scenario.target.id, scenario.target.x + 25, scenario.target.y + 40)],
    {
      isCancelled: () =>
        options.cancelAfterYields !== undefined && yields >= options.cancelAfterYields,
      shouldYield: () => true,
      yieldControl: async () => {
        yields += 1;
        options.onYield?.();
      },
    },
  );
  return { prepared, yields };
}

function connectedLines(target: ReturnType<typeof rectangle>, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...connectedLine(target),
    createdAt: index + 2,
    id: `00000000-0000-4000-8001-${index.toString().padStart(12, "0")}`,
  }));
}
