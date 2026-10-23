import { afterEach, describe, expect, it, vi } from "vitest";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  ElementStore,
  type ElementReplacementHistoryData,
} from "../../../../../src/domain/store/public";
import * as planner from "../../../../../src/domain/store/replacements/replacement-planner";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import { connectedLine, highlighter, rectangle } from "../fixtures";

afterEach(() => vi.restoreAllMocks());

describe("synchronous replacement plan ownership", () => {
  it.each(["elements", "replacements"] as const)(
    "adopts %s with exact propagated history",
    (direction) => {
      const target = rectangle();
      const line = connectedLine(target);
      const store = new ElementStore([target, line]);
      const originals = [store.get(target.id)!.element, store.get(line.id)!.element];
      const candidates = vi.spyOn(planner, "prepareReplacementCandidates");
      const plan = store.planReplacements(
        moveSelection([originals[0] as InkElementV1], { x: 25, y: 10 }),
      )!;
      expect(candidates).toHaveBeenCalledOnce();
      expect(plan.elements).toHaveLength(2);
      expect(plan.replacements).toHaveLength(1);
      expect(store.get(target.id)!.element).toBe(originals[0]);
      const capture = vi.fn<(history: ElementReplacementHistoryData) => void>();
      expect(store.replaceMany(plan[direction], capture)?.changes).toHaveLength(2);
      expect(candidates).toHaveBeenCalledOnce();
      const history = capture.mock.calls[0]![0];
      expect(history.previous).toEqual(originals);
      expect(store.replaceMany(history.previous as readonly InkElementV1[])).not.toBeNull();
      expect(store.get(target.id)!.element).toBe(originals[0]);
      expect(store.get(line.id)!.element).toBe(originals[1]);
      expect(store.replaceMany(history.replacements as readonly InkElementV1[])).not.toBeNull();
      expect(store.get(line.id)!.element).toBe(history.replacements[1]);
    },
  );

  it("isolates mutable request fields and samples before admitting private reuse", () => {
    const source = highlighter();
    const store = new ElementStore([source]);
    const requested = {
      ...source,
      points: [...source.points],
      style: { ...source.style, opacity: 0.75 },
    };
    const plan = store.planReplacements([requested])!;
    requested.style.width = NaN as typeof requested.style.width;
    requested.points[0] = NaN;
    expect(store.replaceMany(plan.elements)).not.toBeNull();
    expect(store.get(source.id)!.element).toMatchObject({
      points: source.points,
      style: { opacity: 0.75, width: 8 },
    });
    expect(() => store.replaceMany([requested])).toThrow(RangeError);
  });

  it.each(["elements", "replacements"] as const)(
    "rejects stale %s after an intervening mutation",
    (direction) => {
      const target = rectangle();
      const store = new ElementStore([target]);
      const plan = store.planReplacements(moveSelection([target], { x: 25, y: 10 }))!;
      store.create(highlighter());
      const publications = vi.fn();
      store.subscribe(publications);
      expect(() => store.replaceMany(plan[direction])).toThrow("Replacement plan is stale.");
      expect(publications).not.toHaveBeenCalled();
      expect(store.get(target.id)!.element).toEqual(target);
    },
  );

  it("does not share private plans across Stores or consume the other array twice", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const other = new ElementStore([target]);
    const candidates = vi.spyOn(planner, "prepareReplacementCandidates");
    const plan = store.planReplacements(moveSelection([target], { x: 25, y: 10 }))!;
    other.replaceMany(plan.elements);
    expect(candidates).toHaveBeenCalledTimes(2);
    store.replaceMany(plan.elements);
    expect(candidates).toHaveBeenCalledTimes(2);
    expect(() => store.replaceMany(plan.replacements)).toThrow("Replacement plan is stale.");
  });
});

describe("synchronous replacement plan misuse", () => {
  it("validates copied arrays and rejects forged replacement fields", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    const candidates = vi.spyOn(planner, "prepareReplacementCandidates");
    const plan = store.planReplacements(moveSelection([target], { x: 25, y: 10 }))!;
    const invalid = [{ ...plan.replacements[0]!, pivot: { x: NaN, y: 0 } }];
    expect(() => store.replaceMany(invalid)).toThrow(RangeError);
    expect(candidates).toHaveBeenCalledTimes(2);
    expect(store.instrumentation.publishedDeltas).toBe(0);
    expect(store.replaceMany([...plan.replacements])).not.toBeNull();
    expect(candidates).toHaveBeenCalledTimes(3);
    expect(() => store.replaceMany(plan.elements)).toThrow("Replacement plan is stale.");
  });

  it("binds preparation to the revision from before reading caller input", () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    let mutated = false;
    const replacements = new Proxy(moveSelection([target], { x: 25, y: 10 }), {
      get(values, key, receiver) {
        if (key === "0" && !mutated) {
          mutated = true;
          store.create(highlighter());
        }
        return Reflect.get(values, key, receiver) as unknown;
      },
    });
    expect(() => store.planReplacements(replacements)).toThrow("Replacement plan is stale.");
    expect(store.get(target.id)!.element).toEqual(target);
    expect(store.instrumentation.recordReplacements).toBe(0);
  });
});
