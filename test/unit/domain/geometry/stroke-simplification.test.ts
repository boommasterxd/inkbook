import { describe, expect, it } from "vitest";
import { simplifyStrokeCenters } from "../../../../src/domain/geometry/stroke-simplification";
import { buildCenterline } from "../../../../src/domain/geometry/stroke-path";

const center = (x: number, y = 0, pressure = 0.5) => ({ x, y, pressure });

describe("bounded stroke simplification", () => {
  it("retains endpoints and exact deterministic window boundaries", () => {
    const source = Array.from({ length: 160 }, (_, index) => center(index));
    expect(simplifyStrokeCenters(source, 8, false)).toEqual([
      source[0],
      source[64],
      source[128],
      source[159],
    ]);
    expect(simplifyStrokeCenters([], 8, false)).toEqual([]);
    expect(simplifyStrokeCenters(source.slice(0, 1), 8, false)).toEqual([source[0]]);
  });

  it("retains pressure extrema that materially change radius, including stationary input", () => {
    const source = [center(0, 0, 0), center(1, 0, 1), center(2, 0, 0)];
    expect(simplifyStrokeCenters(source, 8, true)).toEqual(source);
    expect(simplifyStrokeCenters(source, 8, false)).toEqual([source[0], source[2]]);
    const stationary = source.map((point) => ({ ...point, x: 0 }));
    expect(simplifyStrokeCenters(stationary, 8, true)).toEqual(stationary);
  });

  it("retains identical pressure samples in full and incremental windows", () => {
    const source = Array.from({ length: 160 }, (_, index) => center(index));
    const full = simplifyStrokeCenters(source, 8, true);
    const incremental = [
      ...simplifyStrokeCenters(source.slice(0, 65), 8, true),
      ...simplifyStrokeCenters(source.slice(64, 129), 8, true).slice(1),
      ...simplifyStrokeCenters(source.slice(128), 8, true).slice(1),
    ];
    expect(incremental).toEqual(full);
    expect(full.map((point) => point.x)).toEqual([0, 64, 128, 159]);
  });

  it("preserves long right-angle legs without introducing midpoint corner cuts", () => {
    const source = [
      ...Array.from({ length: 51 }, (_, index) => center(index * 2)),
      ...Array.from({ length: 50 }, (_, index) => center(100, (index + 1) * 2)),
    ];
    const selected = simplifyStrokeCenters(source, 4, false);
    expect(selected).toContain(source[50]);
    const path = buildCenterline(selected);
    expect(path).toContain("L100 0");
    expect(path).not.toMatch(/[QC]/);
  });

  it("does not mutate raw centers and obeys the width-sensitive displacement budget", () => {
    const source = Object.freeze([
      Object.freeze(center(0)),
      Object.freeze(center(1, 0.02)),
      Object.freeze(center(2)),
    ]);
    expect(simplifyStrokeCenters(source, 1, false)).toHaveLength(2);
    expect(simplifyStrokeCenters(source, 0.1, false)).toHaveLength(3);
    expect(source[1]!.y).toBe(0.02);
  });

  it("caps pressure center and radius error independently of broad nominal widths", () => {
    const bend = [center(0), center(1, 0.2), center(2)];
    expect(simplifyStrokeCenters(bend, 22, true)).toEqual(bend);
    expect(simplifyStrokeCenters(bend, 22, false)).toEqual([bend[0], bend[2]]);
    const pressure = [center(0), center(1, 0, 0.52), center(2)];
    expect(simplifyStrokeCenters(pressure, 22, true)).toEqual(pressure);
    const thin = [center(0), center(1, 0.08), center(2)];
    expect(simplifyStrokeCenters(thin, 2, true)).toEqual(thin);
  });
});

describe("pressure filtering within the original sample error budget", () => {
  it("checks filtered endpoints against original positions and radii without adding another allowance", () => {
    const width = 22;
    const original = Array.from({ length: 190 }, (_, index) => ({
      x: index,
      y: Math.sin(index / 11) * 1.5,
      pressure: 0.5 + Math.sin(index / 7) * 0.15 + (index % 2 ? 0.005 : -0.005),
    }));
    const snapshot = original.map((point) => ({ ...point }));
    const selected = simplifyStrokeCenters(original, width, true);
    expect(selected.some((point) => point.pressure !== original[point.x]!.pressure)).toBe(true);
    let segment = 0;
    for (const point of original) {
      while (segment < selected.length - 2 && point.x > selected[segment + 1]!.x) segment += 1;
      const start = selected[segment]!;
      const end = selected[segment + 1]!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const t = Math.max(
        0,
        Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)),
      );
      const position = Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
      const radius =
        Math.abs(point.pressure - start.pressure - t * (end.pressure - start.pressure)) *
        width *
        0.325;
      expect(position + radius).toBeLessThanOrEqual(Math.min(0.125, width / 32) + 1e-10);
    }
    expect(original).toEqual(snapshot);
    for (const index of [0, 64, 128, 189])
      expect(selected.find((point) => point.x === index)!.pressure).toBe(original[index]!.pressure);
  });
});
