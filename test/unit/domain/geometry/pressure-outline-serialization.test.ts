import { roundCanonical } from "../../../../src/domain/geometry/primitives";
import { describe, expect, it } from "vitest";

import {
  buildPressureOutline,
  visitPressureOutline,
} from "../../../../src/domain/geometry/pressure-outline";

interface DecodedCommand {
  command: string;
  values: number[];
}

/** Integer thousandths independently decode relative coordinates without accumulating float error. */
function absoluteCommands(d: string): DecodedCommand[] {
  let current = [0, 0];
  return [...d.matchAll(/([MQAqaZ])([^MQAqaZ]*)/g)].map((match) => {
    const command = match[1]!;
    const values = match[2]!.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g)?.map(Number) ?? [];
    const coordinateStart = command.toUpperCase() === "A" ? 5 : 0;
    for (let index = coordinateStart; index < values.length; index += 1) {
      let thousandths = Math.round(values[index]! * 1000);
      if (command === "q" || command === "a")
        thousandths += current[(index - coordinateStart) % 2]!;
      values[index] = thousandths / 1000;
    }
    if (values.length > 0) current = values.slice(-2).map((value) => Math.round(value * 1000));
    return { command: command.toUpperCase(), values };
  });
}

describe("compact continuous outline serialization", () => {
  it("preserves the exact absolute contour when distant geometry uses relative commands", () => {
    const d = buildPressureOutline(
      [
        { x: 100000, y: 200000, pressure: 0 },
        { x: 100030, y: 200000, pressure: 1 },
      ],
      8,
    )[0]!.d;
    expect(d).toContain("q");
    expect(d).toContain("a");
    expect(absoluteCommands(d)).toEqual([
      { command: "M", values: [100000, 200001.4] },
      { command: "Q", values: [100015, 200002.7, 100030, 200004] },
      { command: "A", values: [4, 4, 0, 0, 0, 100030, 199996] },
      { command: "Q", values: [100015, 199997.3, 100000, 199998.6] },
      { command: "A", values: [1.4, 1.4, 0, 0, 0, 100000, 200001.4] },
      { command: "Z", values: [] },
    ]);
  });

  it("preserves canonical half-value rounding for outline centers and pressure radii", () => {
    const pressure = (3.3335 / 4 - 0.35) / 0.65;
    visitPressureOutline([{ x: 999999.9995, y: -999999.9995, pressure }], 8, (piece) => {
      if (piece.kind !== "dot") throw new Error("Expected a dot");
      expect(piece.center).toEqual({
        x: roundCanonical(999999.9995),
        y: roundCanonical(-999999.9995),
      });
      expect(piece.radius).toBe(roundCanonical((8 * (0.35 + 0.65 * pressure)) / 2));
      return false;
    });
  });

  it("retains shorter absolute commands and rejects oversized relative deltas", () => {
    const small = buildPressureOutline(
      [
        { x: 0, y: 0, pressure: 1 },
        { x: 10, y: 0, pressure: 1 },
      ],
      8,
    )[0]!.d;
    expect(small).toContain("Q");
    const distant = buildPressureOutline(
      [
        { x: -900000, y: 0, pressure: 1 },
        { x: 900000, y: 0, pressure: 1 },
      ],
      8,
    )[0]!.d;
    expect(distant).not.toContain("q");
    expect(absoluteCommands(distant).filter((command) => command.command === "Q")).toHaveLength(2);
  });

  it("keeps every control and endpoint exact across long mixed absolute and relative runs", () => {
    const centers = Array.from({ length: 500 }, (_, index) => ({
      x: 12000 + index * 0.137,
      y: 123456.789,
      pressure: index / 500,
    }));
    const expected: number[][] = [];
    visitPressureOutline(centers, 22, (piece) => {
      if (piece.kind === "strip") {
        expected.push([piece.left[1].x, piece.left[1].y, piece.left[2].x, piece.left[2].y]);
        expected.push([piece.right[1].x, piece.right[1].y, piece.right[0].x, piece.right[0].y]);
      }
      return false;
    });
    const d = buildPressureOutline(centers, 22)[0]!.d;
    const actual = absoluteCommands(d)
      .filter((command) => command.command === "Q")
      .map((command) => command.values);
    expect(actual.map((values) => JSON.stringify(values)).sort()).toEqual(
      expected.map((values) => JSON.stringify(values)).sort(),
    );
  });
});

describe("compact relative fractions", () => {
  it("preserves all positive and negative thousandth fractions without leading zeros", () => {
    for (let thousandths = 1; thousandths < 1000; thousandths += 1) {
      const fraction = thousandths / 1000;
      const d = buildPressureOutline(
        [
          { x: 100, y: 100, pressure: 1 },
          { x: 100 + fraction * 2, y: 100, pressure: 1 },
        ],
        8,
      )[0]!.d;
      const text = String(fraction).slice(1);
      expect(d).toContain(`q${text} `);
      expect(d).toContain(`q-${text} `);
      const controls = absoluteCommands(d).filter((command) => command.command === "Q");
      expect(controls[0]!.values).toEqual([
        roundCanonical(100 + fraction),
        104,
        roundCanonical(100 + fraction * 2),
        104,
      ]);
      expect(controls[1]!.values).toEqual([roundCanonical(100 + fraction), 96, 100, 96]);
    }
  });
});
