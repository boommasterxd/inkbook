import { describe, expect, it } from "vitest";
import { buildPressureCapsule } from "../../../../src/domain/geometry/pressure-joins";
import {
  preparePressureWindows,
  pressureWindowMemoryUsage,
} from "../../../../src/domain/geometry/pressure-window";
import { serializePressureWindows } from "../../../../src/domain/geometry/pressure-path-serialization";
import type { PressureWindow } from "../../../../src/domain/geometry/prepared-pressure-geometry";
import type { PressureOutlinePiece } from "../../../../src/domain/geometry/pressure-outline-piece";
import { decodeSvgPathCommands } from "../../../fixtures/domain/svg-path-fill";

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
  });

  it("falls back to exact native arcs when approximation exceeds its emitted-command budget", () => {
    const [window] = preparePressureWindows(pieces(1));
    expect(window!.additions).toEqual([]);
    expect(window!.loops.flat().some((edge) => edge.kind === "arc")).toBe(true);
    const commands = decodeSvgPathCommands(serializePressureWindows([window!]));
    expect(commands.length).toBeLessThanOrEqual(16);
    expect(commands[commands.length - 1]!.command).toBe("Z");
  });
});
