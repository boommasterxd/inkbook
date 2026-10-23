import { describe, expect, it } from "vitest";
import { PressureBoundaryScalarCache } from "../../../../../src/domain/geometry/pressure/pressure-boundary-scalars";
import type {
  PressureBoundaryArc,
  PressureBoundaryLine,
} from "../../../../../src/domain/geometry/pressure/pressure-joins";

function line(scale: number): PressureBoundaryLine {
  return { kind: "line", start: { x: -scale, y: 0 }, end: { x: 0, y: scale } };
}

describe("window-owned pressure boundary scalars", () => {
  it("retains only bounded boundary identities and releases them before reuse", () => {
    const cache = new PressureBoundaryScalarCache(2);
    const first = line(4);
    const equal = line(4);
    const excess = line(8);
    const prepared = cache.read(first);
    expect(prepared).toEqual({ endpointScale: 4 });
    expect(cache.read(first)).toBe(prepared);
    expect(cache.read(equal)).toEqual(prepared);
    expect(cache.read(equal)).not.toBe(prepared);
    expect(cache.read(excess)).toBeUndefined();
    cache.clear();
    expect(cache.read(excess)).toEqual({ endpointScale: 8 });
    expect(cache.read(first)).not.toBe(prepared);
  });

  it.each([0, -0, Math.PI, -Math.PI, Math.PI * 1.5, -Math.PI * 2])(
    "preserves exact arc sweep scalars for %s",
    (sweep) => {
      const boundary: PressureBoundaryArc = {
        kind: "arc",
        start: { x: 0.25, y: 0 },
        end: { x: -0.25, y: 0 },
        center: { x: 0, y: 0 },
        radius: 0.25,
        sweep,
      };
      expect(new PressureBoundaryScalarCache(1).read(boundary)).toEqual({
        endpointScale: 1,
        absoluteSweep: Math.abs(sweep),
        sweepSign: Math.sign(sweep),
      });
    },
  );

  it("allows an empty window without retaining scalars", () => {
    const cache = new PressureBoundaryScalarCache(0);
    expect(cache.read(line(1))).toBeUndefined();
    cache.clear();
  });

  it.each([-1, 0.5, 257, NaN, Infinity])("rejects invalid capacity %s", (capacity) => {
    expect(() => new PressureBoundaryScalarCache(capacity)).toThrow(RangeError);
  });
});
