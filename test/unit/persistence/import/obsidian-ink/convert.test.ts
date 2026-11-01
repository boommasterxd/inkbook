import { describe, expect, it } from "vitest";
import { convertObsidianInk } from "../../../../../src/persistence/import/obsidian-ink/convert";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import {
  canvasSnapshot,
  canvasStroke,
  canvasStyle,
  inkSvg,
  shapeStyle,
  tldrawShape,
  tldrawSnapshot,
} from "./fixtures";

const options = () => ({
  timestamp: 1234,
  signal: new AbortController().signal,
  checkpoint: () => undefined,
});

describe("Obsidian Ink handwritten document conversion", () => {
  it("preserves official v1 placement, text color and transcript as native compact metadata", async () => {
    const imported = await convertObsidianInk(
      inkSvg(canvasSnapshot(), "ink-canvas", "<transcript>A &amp; B &lt; C&#10;next</transcript>"),
      options(),
    );
    expect(imported.snapshot.page).toEqual({
      innerWidth: 2000,
      margin: 24.3,
      activeBufferLines: 2,
      lockedBufferLines: 1,
      background: { type: "lines", spacing: 100 },
    });
    expect(imported.snapshot.elements[0]).toMatchObject({
      kind: "stroke",
      createdAt: 1234,
      offset: { x: 34.3, y: 44.3 },
      style: { color: { type: "theme-text" }, pressureEnabled: true },
    });
    const points = imported.snapshot.elements[0];
    if (points?.kind !== "stroke") throw new Error("Expected imported handwriting.");
    expect([
      points.points[0],
      points.points[1],
      points.points[points.points.length - 3],
      points.points[points.points.length - 2],
    ]).toEqual([0, 0, 20, 30]);
    expect(imported.transcript).toBe("A & B < C\nnext");
    const serialized = serializeInkbookDocument(imported.snapshot);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) throw new Error(serialized.error.message);
    const parsed = await parseInkbookDocumentForTest(serialized.value.svg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.snapshot).toEqual(imported.snapshot);
  });

  it("decodes v3 integer deltas, style references, offsets and relative timestamps without changing scale", async () => {
    const source = canvasSnapshot({
      version: 3,
      timeBase: 1000,
      strokeStyles: [{ ...canvasStyle, color: "#1234", opacity: 0.8 }],
      strokes: [
        {
          id: "compact",
          style: 0,
          points: [1234, -560, 200, 11, 20, 600],
          offset: [100, -200],
          start: 50,
        },
      ],
      writingBackgroundStyle: "none",
      gridEnabled: true,
      gridStyle: "squares",
      gridSize: 49,
    });
    const result = await convertObsidianInk(inkSvg(source), options());
    expect(result.snapshot.elements[0]).toMatchObject({
      createdAt: 1050,
      offset: { x: 25.3, y: 22.3 },
      style: { opacity: 0.8, color: { type: "rgba", value: "#11223344" } },
    });
    const stroke = result.snapshot.elements[0];
    if (stroke?.kind !== "stroke") throw new Error("Expected imported handwriting.");
    expect([
      stroke.points[0],
      stroke.points[1],
      stroke.points[stroke.points.length - 3],
      stroke.points[stroke.points.length - 2],
    ]).toEqual([12.34, -5.6, 12.45, -5.4]);
    expect(result.snapshot.page.background).toEqual({ type: "squares", spacing: 50 });
    expect(result.warnings).toContain(
      "Background spacing was mapped to the nearest Inkbook preset.",
    );
  });
});

describe("Fractional Obsidian Ink shapes", () => {
  it("derives v3 shape pivots from rounded bounds while retaining fractional placement and rotation", async () => {
    const common = { kind: "shape", style: shapeStyle, offset: { x: 0, y: 0 } };
    const result = await convertObsidianInk(
      inkSvg(
        canvasSnapshot({
          version: 3,
          timeBase: 1000,
          strokeStyles: [],
          strokes: [],
          shapes: [
            {
              ...common,
              id: "rect",
              shapeType: "rect",
              x: 670.0001,
              y: 160.0001,
              w: 382.4034,
              h: 200.8597,
              rotation: 84.311740973,
            },
            {
              ...common,
              id: "ellipse",
              shapeType: "ellipse",
              cx: 1251.7051,
              cy: 290.4746,
              rx: 251.705,
              ry: 110.4746,
            },
          ],
          elementOrder: ["rect", "ellipse"],
        }),
      ),
      options(),
    );
    expect(result.snapshot.elements[0]).toMatchObject({
      kind: "rectangle",
      x: 694.3,
      y: 184.3,
      width: 382.403,
      height: 200.86,
      pivot: { x: 885.501, y: 284.73 },
      rotation: 84.312,
    });
    expect(result.snapshot.elements[1]).toMatchObject({
      kind: "ellipse",
      x: 1024.3,
      y: 204.3,
      width: 503.41,
      height: 220.949,
      pivot: { x: 1276.005, y: 314.774 },
      rotation: 0,
    });
  });
});

describe("Local Obsidian Ink shapes and styles", () => {
  it("imports every local v2 shape with native style, geometry, rotation, arrowheads and z-order", async () => {
    const common = {
      kind: "shape",
      style: { ...shapeStyle, opacity: 0.6, fill: "#FF0000" },
      offset: { x: 2, y: 3 },
    };
    const shapes = [
      { ...common, id: "rect", shapeType: "rect", x: 1, y: 2, w: 40, h: 20, rotation: 30 },
      { ...common, id: "ellipse", shapeType: "ellipse", cx: 10, cy: 20, rx: 8, ry: 4 },
      { ...common, id: "line", shapeType: "line", start: { x: 0, y: 0 }, end: { x: 20, y: 10 } },
      {
        ...common,
        id: "arrow",
        shapeType: "arrow",
        start: { x: 5, y: 6 },
        end: { x: 15, y: 16 },
        arrowheadStart: true,
        arrowheadEnd: false,
      },
    ];
    const result = await convertObsidianInk(
      inkSvg(
        canvasSnapshot({
          version: 2,
          shapes,
          elementOrder: ["line", "rect", "stroke-a", "ellipse", "arrow"],
        }),
      ),
      options(),
    );
    expect(result.snapshot.elements.map((element) => element.kind)).toEqual([
      "line",
      "rectangle",
      "stroke",
      "ellipse",
      "arrow",
    ]);
    expect(result.snapshot.elements[1]).toMatchObject({
      x: 27.3,
      y: 29.3,
      width: 40,
      height: 20,
      rotation: 30,
      pivot: { x: 47.3, y: 39.3 },
      style: { fillOpacity: 0.6 },
    });
    expect(result.snapshot.elements[3]).toMatchObject({ x: 28.3, y: 43.3, width: 16, height: 8 });
    expect(result.snapshot.elements[4]).toMatchObject({
      startNode: "arrow",
      endNode: "none",
      start: { x: 31.3, y: 33.3 },
    });
  });

  it("retains highlight underlayer order and explains width, palette and native brush approximations", async () => {
    const highlight = canvasStroke("highlight");
    Object.assign(highlight.style, {
      brush: "highlighter",
      color: "var(--color-yellow)",
      opacity: 0.35,
      size: 30,
    });
    const result = await convertObsidianInk(
      inkSvg(canvasSnapshot({ strokes: [canvasStroke(), highlight] })),
      options(),
    );
    expect(result.snapshot.elements[0]).toMatchObject({
      tool: "highlighter",
      style: { width: 22, opacity: 0.35, color: { value: "#E0AC00FF" }, pressureEnabled: false },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Stroke width was mapped to the nearest Inkbook preset.",
        "Theme palette colors were frozen to Obsidian's default palette.",
      ]),
    );
  });
});

describe("Legacy tldraw handwriting", () => {
  it("converts official legacy .writing JSON and tldraw SVG through the same native output", async () => {
    const snapshot = tldrawSnapshot();
    const json = await convertObsidianInk(
      JSON.stringify({
        meta: { pluginVersion: "0.4.0", tldrawVersion: "2.1.0" },
        tldraw: snapshot,
        previewUri: "data:image/png;base64,unused",
      }),
      {
        ...options(),
        legacyWriting: true,
      },
    );
    const svg = await convertObsidianInk(inkSvg(snapshot, "tldraw"), options());
    expect(json.snapshot).toEqual(svg.snapshot);
    expect(svg.snapshot.elements[0]).toMatchObject({
      points: [0, 0, 0.2, 10, 20, 0.8],
      offset: { x: 124.3, y: 224.3 },
      style: { width: 4 },
    });
    expect(svg.warnings.some((warning) => warning.includes("stash"))).toBe(true);
  });

  it("preserves legacy vector shapes and orders records by their actual stacking index", async () => {
    const ellipse = {
      ...tldrawShape("shape:ellipse", "geo", {
        geo: "ellipse",
        w: 80,
        h: 40,
        fill: "solid",
        color: "red",
      }),
      index: "a2",
    };
    const arrow = {
      ...tldrawShape("shape:arrow", "arrow", {
        start: { type: "point", x: 0, y: 0 },
        end: { type: "point", x: 40, y: 20 },
        arrowheadStart: "dot",
        arrowheadEnd: "triangle",
      }),
      index: "a1",
    };
    const result = await convertObsidianInk(
      inkSvg(tldrawSnapshot([ellipse, arrow]), "tldraw"),
      options(),
    );
    expect(result.snapshot.elements.map((element) => element.kind)).toEqual(["arrow", "ellipse"]);
    expect(result.snapshot.elements[0]).toMatchObject({
      startNode: "circle",
      endNode: "triangle",
      end: { x: 164.3, y: 244.3 },
    });
    expect(result.snapshot.elements[1]).toMatchObject({
      width: 80,
      height: 40,
      style: { fillColor: { value: "#E03131FF" } },
    });
  });
});
