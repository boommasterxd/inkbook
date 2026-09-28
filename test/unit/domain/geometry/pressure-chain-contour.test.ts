import { describe, expect, it } from "vitest";
import { pressureChainContour } from "../../../../src/domain/geometry/pressure-chain-contour";
import {
  buildPressureCapsule,
  type PressureCenter,
} from "../../../../src/domain/geometry/pressure-joins";
import { samplePressureContour } from "../../../fixtures/domain/pressure-contour";
import { pressureCapsuleContains } from "../../../../src/domain/geometry/pressure-capsule-containment";
import type { PointV1 } from "../../../../src/domain/schema/types";
import { polygonWinding } from "../../../fixtures/domain/svg-path-fill";

function shapes(centers: readonly PressureCenter[], width = 4) {
  return centers.slice(1).map((last, index) => buildPressureCapsule(centers[index]!, last, width));
}
function contains(source: ReturnType<typeof shapes>, point: PointV1): boolean {
  return source.some((shape) =>
    shape.kind === "capsule"
      ? pressureCapsuleContains(shape, point)
      : Math.hypot(point.x - shape.center.x, point.y - shape.center.y) <= shape.radius,
  );
}

it("matches independently filled capsules for regular turns, varying pressure and crossing runs", () => {
  let seed = 413;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let accepted = 0;
  for (let trial = 0; trial < 100; trial += 1) {
    const centers = [{ x: 0, y: 0, pressure: random() }];
    let angle = random() * Math.PI * 2;
    for (let index = 1; index < 16; index += 1) {
      angle += (random() - 0.5) * 2;
      const last = centers[index - 1]!;
      centers.push({
        x: last.x + Math.cos(angle) * 5,
        y: last.y + Math.sin(angle) * 5,
        pressure: random(),
      });
    }
    const source = shapes(centers);
    const contour = pressureChainContour(source);
    if (contour === undefined) continue;
    accepted += 1;
    const actual = samplePressureContour(contour);
    for (let probe = 0; probe < 200; probe += 1) {
      const center = centers[probe % centers.length]!;
      const point = { x: center.x + (random() - 0.5) * 8, y: center.y + (random() - 0.5) * 8 };
      expect(polygonWinding(actual, point) !== 0, `trial ${trial}, probe ${probe}`).toBe(
        contains(source, point),
      );
    }
  }
  expect(accepted).toBeGreaterThan(50);
});

it("preserves crossing fill and enclosed holes without Boolean contour stitching", () => {
  const centers = Array.from({ length: 65 }, (_, index) => {
    const angle = (index / 64) * 2 * Math.PI;
    return { x: Math.sin(angle) * 30, y: Math.sin(angle * 2) * 20, pressure: 0.7 };
  });
  const source = shapes(centers, 1);
  const contour = pressureChainContour(source);
  expect(contour).toBeDefined();
  const actual = samplePressureContour(contour!);
  for (let x = -30.1; x < 31; x += 0.71) {
    for (let y = -21.1; y < 21; y += 0.69) {
      const point = { x, y };
      expect(polygonWinding(actual, point) !== 0).toBe(contains(source, point));
    }
  }
  expect(polygonWinding(actual, { x: 0, y: 0 })).not.toBe(0);
  expect(polygonWinding(actual, { x: 20, y: 0 })).toBe(0);
});

describe("unsupported pressure chains", () => {
  it("leaves empty, single, disconnected and disk-containing windows to the exact union", () => {
    const source = shapes([
      { x: 0, y: 0, pressure: 1 },
      { x: 10, y: 0, pressure: 1 },
      { x: 20, y: 2, pressure: 1 },
    ]);
    expect(pressureChainContour([])).toBeUndefined();
    expect(pressureChainContour(source.slice(0, 1))).toBeUndefined();
    expect(pressureChainContour([source[0]!, source[0]!])).toBeUndefined();
    expect(
      pressureChainContour([...source, { kind: "dot", center: { x: 0, y: 0 }, radius: 1 }]),
    ).toBeUndefined();
  });
  it("rejects reversals and overlapping inside joins instead of cutting holes", () => {
    for (const centers of [
      [
        { x: 0, y: 0, pressure: 1 },
        { x: 10, y: 0, pressure: 1 },
        { x: 0, y: 0, pressure: 1 },
      ],
      [
        { x: 0, y: 0, pressure: 1 },
        { x: 0.1, y: 0, pressure: 1 },
        { x: 0.1, y: 0.1, pressure: 1 },
      ],
    ])
      expect(pressureChainContour(shapes(centers, 22))).toBeUndefined();
  });
});
