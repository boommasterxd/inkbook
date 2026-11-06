import { afterEach, expect, it, vi } from "vitest";
import * as geometry from "../../../../src/domain/geometry/primitives";
import { recognizeLinear } from "../../../../src/domain/recognition/linear-recognition";

afterEach(() => vi.restoreAllMocks());

it("straightens a maximum normalized shallow bow with linear work and no quadratic fitting", () => {
  const count = 256;
  const points = Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    return { x: 240 * t, y: 48 * t * (1 - t) };
  });
  const distance = vi.spyOn(geometry, "pointDistance");
  const segment = vi.spyOn(geometry, "pointSegmentDistance");
  const curve = vi.spyOn(geometry, "quadraticPoint");
  expect(recognizeLinear(points)).toMatchObject({ kind: "line", bend: null });
  // Chord, length, time parameterization and at most two supported-corner distances per point.
  expect(distance.mock.calls.length).toBeGreaterThan(count * 2);
  expect(distance.mock.calls.length).toBeLessThanOrEqual(count * 4);
  expect(segment).toHaveBeenCalledTimes(count);
  expect(curve).not.toHaveBeenCalled();
});

it("approximates a maximum normalized semicircle with bounded fitting and tangent work", () => {
  const count = 256;
  const points = Array.from({ length: count }, (_, index) => {
    const angle = (Math.PI * index) / (count - 1);
    return { x: 120 * (1 - Math.cos(angle)), y: -120 * Math.sin(angle) };
  });
  const distance = vi.spyOn(geometry, "pointDistance");
  const curve = vi.spyOn(geometry, "quadraticPoint");
  const tangent = vi.spyOn(Math, "atan2");
  const result = recognizeLinear(points);
  expect(result?.kind).toBe("line");
  expect(result?.bend).not.toBeNull();
  // Six alternating fits, six normal refinements and final projection use at most 85 evaluations
  // per source point. The fallback samples 16 spans once, without another quadratic fit.
  expect(curve.mock.calls.length).toBeGreaterThan(count);
  expect(curve.mock.calls.length).toBeLessThanOrEqual(count * 85);
  expect(distance.mock.calls.length).toBeLessThanOrEqual(count * 5);
  expect(tangent).toHaveBeenCalledTimes(15);
});
