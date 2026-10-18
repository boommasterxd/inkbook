import { describe, expect, it, vi } from "vitest";

import { rotatePointClockwise } from "../../../../src/domain/geometry/public";
import { markStoredStroke } from "../../../../src/domain/elements/stroke-replacement-proof";
import type { PointV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { createSweptCapsuleCheck } from "../../../../src/editor/gestures/eraser-intersection";
import {
  EraserStrokeIndexCache,
  MAX_ERASER_INDEX_BYTES,
  MAX_ERASER_INDEX_ENTRIES,
  MAX_ERASER_INDEX_NODES,
} from "../../../../src/editor/gestures/eraser-stroke-index";
import { indexedStroke } from "../../../fixtures/editor/stroke";

describe("gesture-owned stroke section indexes", () => {
  it("requires stored ownership instead of trusting frozen containers or mutable samples", () => {
    const cache = new EraserStrokeIndexCache();
    const stroke = strokeWithPoints(64);
    cache.rememberMiss(stroke);
    expect(cache.acquire(stroke)).toBeNull();
    const unsafe = Object.freeze({
      ...stroke,
      points: new Float64Array(stroke.points),
    }) as unknown as StrokeElementV1;
    cache.rememberMiss(unsafe);
    expect(cache.acquire(unsafe)).toBeNull();
    expect(cache.byteLength).toBe(0);
    const owned = ownedStroke(stroke);
    expect(cache.acquire(owned)).toBeNull();
    cache.rememberMiss(owned);
    expect(cache.acquire(owned)).toBe(cache.acquire(owned));
    const replacement = ownedStroke({ ...stroke, points: [...stroke.points] });
    cache.rememberMiss(replacement);
    expect(cache.acquire(replacement)).not.toBe(cache.acquire(owned));
    const short = ownedStroke(strokeWithPoints(63));
    cache.rememberMiss(short);
    expect(cache.acquire(short)).toBeNull();
    const cold = ownedStroke(strokeWithPoints(64));
    cache.rememberMiss(cold);
    cache.clear();
    expect(cache.acquire(cold)).toBeNull();
    expect(cache.byteLength).toBe(0);
    expect(cache.nodeCount).toBe(0);
  });

  it.each([false, true])(
    "preserves exact indexed contact with a degenerate first segment: %s",
    (duplicate) => {
      const stroke = strokeWithPoints(131, duplicate);
      const owned = ownedStroke(stroke);
      const cache = warmedIndex(owned);
      for (const y of [-2.001, -2, 0, 2, 2.001]) {
        const start = { x: 10, y };
        const end = { x: 120, y };
        expect(check(start, end, owned, cache)).toBe(Math.abs(y) <= 2);
        expect(check(start, end, owned, cache)).toBe(check(start, end, owned));
      }
    },
  );

  it("keeps offset, rotation, pressure, highlighter width and large-coordinate boundaries exact", () => {
    for (const base of [0, 800_000]) {
      const points = Array.from({ length: 131 }, (_, index) => [
        base + index,
        base + index,
        0.5,
      ]).flat();
      const stroke = ownedStroke({
        ...strokeWithPoints(131),
        offset: { x: 11, y: -9 },
        pivot: { x: base + 65, y: base + 65 },
        points,
        rotation: 37,
        style: { ...indexedStroke(1).style, pressureEnabled: false },
        tool: "highlighter",
      });
      const cache = warmedIndex(stroke);
      for (const distance of [-5, -3.5, 0, 3.5, 5]) {
        const normal = distance / Math.sqrt(2);
        const start = worldPoint(stroke, { x: base + 5 + normal, y: base + 5 - normal });
        const end = worldPoint(stroke, { x: base + 125 + normal, y: base + 125 - normal });
        expect(check(start, end, stroke, cache)).toBe(check(start, end, stroke));
      }
      expect(
        check(
          worldPoint(stroke, { x: base, y: base }),
          worldPoint(stroke, { x: base + 130, y: base + 130 }),
          stroke,
          cache,
        ),
      ).toBe(true);
    }
  });

  it("keeps curved and reversing sections conservative across point and continuous sweeps", () => {
    const stroke = ownedStroke({
      ...strokeWithPoints(131),
      points: Array.from({ length: 131 }, (_, index) => [
        index,
        Math.abs((index % 16) - 8) * 3,
        (index % 5) / 4,
      ]).flat(),
    });
    const cache = warmedIndex(stroke);
    for (const x of [10, 35, 66, 99]) {
      for (const y of [-2, 10, 27]) {
        const start = { x, y };
        for (const end of [start, { x: x + 10, y: y + 15 }]) {
          expect(check(start, end, stroke, cache)).toBe(check(start, end, stroke));
        }
      }
    }
  });
});

describe("stroke index identity and retention", () => {
  it("does not reuse geometry after replacement or accept mutable standalone geometry", () => {
    const original = strokeWithPoints(131);
    const owned = ownedStroke(original);
    const cache = warmedIndex(owned);
    const changed = {
      ...original,
      points: original.points.map((value, index) => (index % 3 === 1 ? value + 20 : value)),
    };
    expect(check({ x: 0, y: 20 }, { x: 130, y: 20 }, ownedStroke(changed), cache)).toBe(true);
    expect(check({ x: 0, y: 20 }, { x: 130, y: 20 }, changed, cache)).toBe(true);
    const points = changed.points;
    for (let index = 1; index < points.length; index += 3) points[index] = 40;
    expect(check({ x: 0, y: 40 }, { x: 130, y: 40 }, changed, cache)).toBe(true);
  });

  it("bounds retained nodes, byte buffers and entries while evicting the least recent identity", () => {
    const cache = new EraserStrokeIndexCache();
    const first = ownedStroke(strokeWithPoints(64));
    const second = ownedStroke(strokeWithPoints(64));
    cache.rememberMiss(first);
    cache.rememberMiss(second);
    const firstIndex = cache.acquire(first);
    const secondIndex = cache.acquire(second);
    cache.acquire(first);
    // New immutable identities share only the already Store-owned immutable samples.
    for (let index = 2; index <= MAX_ERASER_INDEX_ENTRIES; index += 1) {
      cache.rememberMiss(markStoredStroke(Object.freeze({ ...first })));
    }
    expect(cache.acquire(first)).toBe(firstIndex);
    expect(cache.acquire(second)).toBeNull();
    cache.rememberMiss(second);
    expect(cache.acquire(second)).not.toBe(secondIndex);
    const maximum = ownedStroke(strokeWithPoints(16_384));
    for (let index = 0; index < 150; index += 1) {
      const identity = markStoredStroke(Object.freeze({ ...maximum }));
      cache.rememberMiss(identity);
      cache.acquire(identity);
      expect(cache.nodeCount).toBeLessThanOrEqual(MAX_ERASER_INDEX_NODES);
      expect(cache.byteLength).toBeLessThanOrEqual(MAX_ERASER_INDEX_BYTES);
    }
    expect(cache.byteLength).toBeGreaterThan(4 * 1_024 * 1_024);
    cache.clear();
    expect(cache.byteLength).toBe(0);
  });
});

it.each([0, 37, -90, -180])(
  "shares endpoint rotation and avoids zero-angle trigonometry at %s degrees",
  (rotation) => {
    const stroke = ownedStroke({ ...strokeWithPoints(131), rotation, offset: { x: 11, y: -9 } });
    const point = worldPoint(stroke, { x: 65, y: 0 });
    const sine = vi.spyOn(Math, "sin");
    const cosine = vi.spyOn(Math, "cos");
    try {
      expect(check(point, point, stroke)).toBe(true);
      expect(sine).toHaveBeenCalledTimes(rotation === 0 ? 0 : 1);
      expect(cosine).toHaveBeenCalledTimes(rotation === 0 ? 0 : 1);
    } finally {
      sine.mockRestore();
      cosine.mockRestore();
    }
  },
);

function strokeWithPoints(count: number, duplicate = false): StrokeElementV1 {
  return {
    ...indexedStroke(1),
    pivot: { x: count / 2, y: 0 },
    points: Array.from({ length: count }, (_, index) => [
      duplicate && index === 1 ? 0 : index,
      0,
      0.5,
    ]).flat(),
  };
}

function ownedStroke(stroke: StrokeElementV1): StrokeElementV1 {
  return new ElementStore([stroke]).get(stroke.id)!.element as StrokeElementV1;
}

function warmedIndex(stroke: StrokeElementV1): EraserStrokeIndexCache {
  const cache = new EraserStrokeIndexCache();
  expect(check({ x: -10_000, y: -10_000 }, { x: -9_000, y: -9_000 }, stroke, cache)).toBe(false);
  expect(cache.byteLength).toBe(0);
  expect(check({ x: -10_000, y: -10_000 }, { x: -9_000, y: -9_000 }, stroke, cache)).toBe(false);
  return cache;
}

function worldPoint(stroke: StrokeElementV1, local: PointV1): PointV1 {
  return rotatePointClockwise(
    { x: local.x + (stroke.offset?.x ?? 0), y: local.y + (stroke.offset?.y ?? 0) },
    stroke.pivot,
    stroke.rotation,
  );
}

function check(
  start: PointV1,
  end: PointV1,
  stroke: StrokeElementV1,
  cache?: EraserStrokeIndexCache,
): boolean {
  const check = createSweptCapsuleCheck(start, end, 1, stroke, cache);
  let progress = check.advance(1);
  while (progress.result === null) progress = check.advance(1);
  return progress.result;
}
