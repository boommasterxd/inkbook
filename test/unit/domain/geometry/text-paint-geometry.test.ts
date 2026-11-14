import { describe, expect, it } from "vitest";
import {
  prepareTextPaintGeometrySteps,
  type TextPaintGeometry,
  type TextPaintRegion,
} from "../../../../src/domain/geometry/text-paint-geometry";
import { textTableGridPathSteps } from "../../../../src/domain/geometry/text-table-grid-path";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { textElement, textMathLayout } from "../schema/fixtures";

function prepare(element = textElement()): TextPaintGeometry {
  return finishGeometrySteps(prepareTextPaintGeometrySteps(element));
}

function regionsAt(geometry: TextPaintGeometry, x: number, y: number): TextPaintRegion[] {
  const result: TextPaintRegion[] = [];
  geometry.query({ minX: x, minY: y, maxX: x, maxY: y }, (region) => {
    result.push(region);
    return true;
  });
  return result;
}

describe("retained text paint", () => {
  it("uses local line advances and leaves empty field space untargeted", () => {
    const element = textElement();
    element.layout.lines[0]!.x = 8;
    element.layout.lines[0]!.y = 6;
    element.layout.lines[0]!.runs[0]!.x = 4;
    const geometry = prepare(element);
    expect(regionsAt(geometry, 15, 10)).toEqual([{ x: 12, y: 6, width: 40, height: 20 }]);
    expect(regionsAt(geometry, 80, 10)).toEqual([]);
    expect(regionsAt(geometry, 15, 40)).toEqual([]);
    expect(regionsAt(geometry, 115, 110)).toEqual([]);
  });

  it("joins styled runs into a line target including spaces and gaps but excludes blank lines", () => {
    const element = textElement();
    const line = element.layout.lines[0]!;
    element.source = "A   S\n   ";
    line.x = 8;
    line.y = 6;
    line.width = 39;
    line.runs = [
      { text: "A", start: 0, end: 1, x: 4, width: 8 },
      { text: "   ", start: 1, end: 4, x: 12, width: 12, style: { bold: true } },
      { text: "S", start: 4, end: 5, x: 30, width: 9, style: { italic: true } },
    ];
    element.layout.lines.push({
      ...line,
      y: 28,
      width: 12,
      runs: [{ text: "   ", start: 6, end: 9, x: 0, width: 12 }],
    });
    const geometry = prepare(element);
    expect(regionsAt(geometry, 16, 16)).toEqual([{ x: 12, y: 6, width: 35, height: 20 }]);
    expect(regionsAt(geometry, 25, 10)).toHaveLength(1);
    expect(regionsAt(geometry, 35, 10)).toHaveLength(1);
    expect(regionsAt(geometry, 48, 10)).toEqual([]);
    expect(regionsAt(geometry, 10, 35)).toEqual([]);
    element.source = "A   SX\n   ";
    element.layout.lines[1]!.runs[0]!.start = 7;
    element.layout.lines[1]!.runs[0]!.end = 10;
    line.width = 69;
    line.runs.push({ text: "X", start: 5, end: 6, x: 60, width: 9, style: { opacity: 0 } });
    expect(regionsAt(prepare(element), 65, 10)).toEqual([]);
  });

  it("ignores whitespace without decoration and retains decorated spaces", () => {
    const element = textElement();
    element.layout.lines[0]!.runs[0]!.text = "  ";
    expect(prepare(element).regions).toEqual([]);
    element.style.underline = true;
    expect(prepare(element).regions).toHaveLength(1);
    element.style.underline = false;
    element.layout.lines[0]!.runs[0]!.style = { strikethrough: true };
    expect(prepare(element).regions).toHaveLength(1);
  });

  it("excludes transparent run paints through effective opacity and color", () => {
    const element = textElement();
    element.style.opacity = 0;
    expect(prepare(element).regions).toEqual([]);
    element.layout.lines[0]!.runs[0]!.style = { opacity: 1 };
    expect(prepare(element).regions).toHaveLength(1);
    element.layout.lines[0]!.runs[0]!.style.color = { type: "rgba", value: "#AA330000" };
    expect(prepare(element).regions).toEqual([]);
  });
});

describe("retained text backgrounds and structured content", () => {
  it("subtracts transparent background overrides and retains rounded clipping", () => {
    const element = textElement();
    element.style.opacity = 0;
    element.backgroundColor = { type: "theme-text" };
    element.backgroundOpacity = 1;
    const run = element.layout.lines[0]!.runs[0]!;
    run.style = { backgroundColor: null };
    const geometry = prepare(element);
    expect(regionsAt(geometry, 20, 10)).toEqual([]);
    expect(regionsAt(geometry, 80, 10)).toHaveLength(1);
    expect(geometry.regions.every((region) => region.roundedClip?.width === 100)).toBe(true);
    run.style = { backgroundOpacity: 0.5 };
    expect(regionsAt(prepare(element), 20, 10)).toHaveLength(1);
    run.style = { backgroundColor: { type: "rgba", value: "#AA330000" } };
    expect(regionsAt(prepare(element), 20, 10)).toEqual([]);
  });

  it("clips range backgrounds to the field and paints them without a base background", () => {
    const element = textElement();
    element.style.opacity = 0;
    element.layout.lines[0]!.x = -10;
    element.layout.lines[0]!.y = -5;
    element.layout.lines[0]!.runs[0]!.style = {
      backgroundColor: { type: "theme-text" },
      backgroundOpacity: 0.5,
    };
    expect(prepare(element).regions).toMatchObject([{ x: 0, y: 0, width: 30, height: 15 }]);
  });

  it("uses math range paint and ignores formula boxes without glyph paths", () => {
    const element = textElement();
    element.style.opacity = 0;
    element.layout.math = [textMathLayout()];
    expect(prepare(element).regions).toEqual([]);
    element.ranges = [{ start: 0, end: 5, style: { opacity: 1 } }];
    expect(regionsAt(prepare(element), 25, 30)).toHaveLength(1);
    element.layout.math[0]!.paths = [];
    expect(prepare(element).regions).toEqual([]);
    element.ranges[0]!.style = { backgroundColor: { type: "theme-text" }, backgroundOpacity: 1 };
    expect(regionsAt(prepare(element), 25, 30)).toHaveLength(1);
  });

  it("targets table strips rather than empty cells and preserves the serialized grid", () => {
    const element = textElement();
    element.layout.lines = [];
    const table = {
      start: 0,
      end: 5,
      x: 10,
      y: 5,
      width: 80,
      height: 40,
      columns: 2,
      rowHeights: [20, 20],
      borderWidth: 1,
    };
    element.layout.tables = [table];
    const geometry = prepare(element);
    expect(regionsAt(geometry, 50, 15)).toHaveLength(1);
    expect(regionsAt(geometry, 30, 25)).toHaveLength(1);
    expect(regionsAt(geometry, 30, 15)).toEqual([]);
    expect(finishGeometrySteps(textTableGridPathSteps(table))).toBe(
      "M10 5H90V6H10ZM10 44H90V45H10ZM10 5H11V45H10ZM89 5H90V45H89Z" +
        "M49.5 5H50.5V45H49.5ZM10 24.5H90V25.5H10Z",
    );
    element.style.opacity = 0;
    expect(prepare(element).regions).toEqual([]);
    element.style.opacity = 1;
    table.borderWidth = 0;
    expect(prepare(element).regions).toEqual([]);
  });
});

describe("paint query ownership", () => {
  it("queries unsorted retained lines and stops when the visitor accepts a hit", () => {
    const element = textElement();
    const line = element.layout.lines[0]!;
    element.layout.lines = [80, 0, 40].map((y) => ({ ...line, y }));
    const geometry = prepare(element);
    expect(regionsAt(geometry, 10, 45)).toMatchObject([{ y: 40 }]);
    let hits = 0;
    expect(
      geometry.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, () => {
        hits += 1;
        return false;
      }),
    ).toBe(false);
    expect(hits).toBe(1);
    const steps = geometry.querySteps({ minX: 0, minY: 40, maxX: 20, maxY: 45 });
    expect([...steps].filter(Boolean)).toMatchObject([{ y: 40 }]);
    expect([...geometry.querySteps()].filter(Boolean)).toHaveLength(3);
  });

  it("allows cancellation without retaining a partial query and rejects invalid bounds", () => {
    const geometry = prepare();
    const query = geometry.querySteps();
    expect(query.next().value).toMatchObject({ width: 40 });
    query.return(undefined);
    expect(regionsAt(geometry, 10, 10)).toHaveLength(1);
    const bounds = { minX: Number.NaN, minY: 0, maxX: 20, maxY: 20 };
    expect([...geometry.querySteps(bounds)]).toEqual([]);
    expect(
      geometry.query(bounds, () => {
        throw new Error("Invalid bounds visited paint.");
      }),
    ).toBe(true);
    expect(prepare({ ...textElement(), layout: { version: 1, lines: [] } }).regions).toEqual([]);
    expect(geometry.memoryUsage()).toBeGreaterThan(geometry.regions.length * 96);
  });
});
