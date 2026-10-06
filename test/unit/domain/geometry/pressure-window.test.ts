import { describe, expect, it, vi } from "vitest";
import * as approximation from "../../../../src/domain/geometry/pressure-contour-approximation";
import { buildPressureCapsule } from "../../../../src/domain/geometry/pressure-joins";
import {
  preparePressureWindowSteps,
  preparePressureWindows,
  pressureWindowMemoryUsage,
  PRESSURE_WINDOW_SCRATCH_BYTES,
} from "../../../../src/domain/geometry/pressure-window";
import { serializePressureWindows } from "../../../../src/domain/geometry/pressure-path-serialization";
import type { PressureWindow } from "../../../../src/domain/geometry/prepared-pressure-geometry";
import type { PressureOutlinePiece } from "../../../../src/domain/geometry/pressure-outline-piece";
import { decodeSvgPathCommands } from "../../../fixtures/domain/svg-path-fill";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";

function pieces(count: number): PressureOutlinePiece[] {
  return Array.from({ length: count }, (_, index) => {
    const capsule = buildPressureCapsule(
      { x: index * 10, y: 0, pressure: 1 },
      { x: (index + 1) * 10, y: 0, pressure: 1 },
      22,
    );
    if (capsule.kind === "dot") throw new Error("Expected nonstationary capsule");
    return { kind: "strip", capsule, width: 22 };
  });
}

describe("canonical pressure windows", () => {
  it("reuses the owner cache by emitted-piece partition without recomputing geometry", () => {
    const stored = new Map<number, PressureWindow>();
    const cache = {
      readWindow: (index: number) => stored.get(index),
      publishWindow: (index: number, window: PressureWindow) => {
        stored.set(index, window);
      },
    };
    const source = pieces(65);
    const first = preparePressureWindows(source, cache);
    expect(first).toHaveLength(2);
    const cachedSource = new Proxy(source, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key))
          throw new Error("Unexpected geometry read");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const second = preparePressureWindows(cachedSource, cache);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(pressureWindowMemoryUsage(first[0]!)).toBeGreaterThan(0);
    expect(PRESSURE_WINDOW_SCRATCH_BYTES).toBe(2_441_584);
  });

  it("falls back to exact native arcs when approximation exceeds its emitted-command budget", () => {
    const [window] = preparePressureWindows(pieces(1));
    expect(window!.additions).toEqual([]);
    expect(window!.loops.flat().some((edge) => edge.kind === "arc")).toBe(true);
    const commands = decodeSvgPathCommands(serializePressureWindows([window!]));
    expect(commands.length).toBeLessThanOrEqual(16);
    expect(commands[commands.length - 1]!.command).toBe("Z");
  });

  it.each([1, 64])("preserves native command fallback in path-only mode (%i pieces)", (count) => {
    const source = pieces(count);
    const full = finishGeometrySteps(preparePressureWindowSteps(source));
    const path = finishGeometrySteps(preparePressureWindowSteps(source, "path-only"));
    expect(path.kind).toBe("path-window");
    expect(path).not.toHaveProperty("additions");
    expect(serializePressureWindows([path])).toBe(serializePressureWindows([full]));
    expect(pressureWindowMemoryUsage(path)).toBeGreaterThan(0);
  });

  it("preserves complete capsules when an adversarial exact union exhausts its allowance", () => {
    const source = Array.from({ length: 64 }, (_, index) => {
      const capsule = buildPressureCapsule(
        { x: index % 2 ? 0 : 200, y: index * 0.1, pressure: index % 2 },
        { x: index % 2 ? 200 : 0, y: (index + 1) * 0.1, pressure: (index + 1) % 2 },
        22,
      );
      return capsule.kind === "dot" ? capsule : { kind: "strip" as const, capsule, width: 22 };
    });
    const full = finishGeometrySteps(preparePressureWindowSteps(source));
    const path = finishGeometrySteps(preparePressureWindowSteps(source, "path-only"));
    expect(full.additions).toEqual([]);
    expect(full.loops).toHaveLength(64);
    expect(path.loops).toEqual(full.loops);
  });

  it.each([16_384, 16_385])(
    "keeps the exact addition-capacity decision for %i additions",
    (count) => {
      const source = pieces(2);
      const triangle = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ];
      const prepare = vi
        .spyOn(approximation, "iteratePressureContourApproximation")
        .mockImplementation(function* (_loop, _width, additions) {
          if (Array.isArray(additions))
            additions.push(...Array.from({ length: count }, () => triangle));
          else additions.count += count;
          yield;
          return [];
        });
      try {
        const full = finishGeometrySteps(preparePressureWindowSteps(source));
        const path = finishGeometrySteps(preparePressureWindowSteps(source, "path-only"));
        expect(path.loops).toEqual(full.loops);
        expect(full.additions).toHaveLength(count > 16_384 ? 0 : count);
        expect(full.loops.flat().length > 0).toBe(count > 16_384);
      } finally {
        prepare.mockRestore();
      }
    },
  );
});
