import { describe, expect, it } from "vitest";
import { validateRuntimeReplacement } from "../../../../src/domain/elements/runtime-replacement-validation";
import {
  getCanonicalStrokeReplacementProof,
  markCanonicalStrokeReplacement,
} from "../../../../src/domain/elements/stroke-replacement-proof";
import { MAX_ABSOLUTE_COORDINATE } from "../../../../src/domain/schema/constants";
import { validateInkElementV1 } from "../../../../src/domain/schema/element-validation";
import type { StrokeElementV1 } from "../../../../src/domain/schema/types";
import { ElementStore } from "../../../../src/domain/store/public";
import { moveSelection } from "../../../../src/editor/selection/transforms";
import { stroke } from "../schema/fixtures";

const limit = MAX_ABSOLUTE_COORDINATE;

function ownedStroke(element = stroke()): StrokeElementV1 {
  return new ElementStore([element]).get(element.id)!.element as StrokeElementV1;
}

function frozenMove(source: StrokeElementV1): StrokeElementV1 {
  return Object.freeze({
    ...source,
    offset: Object.freeze({ x: 2, y: 3 }),
    pivot: Object.freeze({ x: source.pivot.x + 2, y: source.pivot.y + 3 }),
  });
}

describe("stroke offset validation", () => {
  it("accepts omitted offsets and translated boundary coordinates", () => {
    expect(validateInkElementV1(stroke()).ok).toBe(true);
    expect(
      validateInkElementV1({ ...stroke(), offset: { x: limit - 120, y: -limit + 100 } }).ok,
    ).toBe(true);
  });

  it.each([
    { x: limit - 119, y: 0 },
    { x: 0, y: -limit - 101 },
    { x: Number.NaN, y: 0 },
    { x: 0.0001, y: 0 },
    { x: 0, y: 0, extra: true },
    null,
  ])("rejects malformed or overflowing external offset %o", (offset) => {
    expect(validateInkElementV1({ ...stroke(), offset }).ok).toBe(false);
  });

  it("rechecks effective extrema and header fields for sample-reusing replacements", () => {
    const source = ownedStroke();
    expect(validateRuntimeReplacement(source, frozenMove(source)).ok).toBe(true);
    expect(
      validateRuntimeReplacement(source, { ...source, offset: { x: limit - 119, y: 0 } }).ok,
    ).toBe(false);
    expect(validateRuntimeReplacement(source, { ...source, rotation: Number.NaN }).ok).toBe(false);
    const changed = { ...source, points: [Number.NaN, 0, 0.5] };
    expect(validateRuntimeReplacement(source, changed).ok).toBe(false);
  });

  it("rejects forged translation proofs before any bypass can be retained", () => {
    const source = ownedStroke();
    for (const patch of [
      { rotation: 30 },
      { points: Object.freeze([1, 2, 0.5]) as unknown as number[] },
      { style: Object.freeze({ ...source.style, width: 8 as const }) },
      { offset: Object.freeze({ x: 3, y: 3 }) },
    ]) {
      const forged = Object.freeze({ ...frozenMove(source), ...patch });
      expect(() => markCanonicalStrokeReplacement(source, forged, { x: 2, y: 3 })).toThrow();
      expect(getCanonicalStrokeReplacementProof(forged)).toBeUndefined();
    }
  });

  it("rejects translated samples beyond the limit even when pivot and offset remain valid", () => {
    const source = ownedStroke({ ...stroke(), points: [limit, 100, 0.5] });
    expect(() => moveSelection([source], { x: 1, y: 0 })).toThrow();
  });
});
