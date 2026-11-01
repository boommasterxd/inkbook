import { describe, expect, it } from "vitest";
import { convertObsidianInk } from "../../../../../src/persistence/import/obsidian-ink/convert";
import {
  canvasSnapshot,
  canvasStroke,
  inkSvg,
  shapeStyle,
  tldrawShape,
  tldrawSnapshot,
} from "./fixtures";

const options = () => ({
  timestamp: 100,
  signal: new AbortController().signal,
  checkpoint: () => undefined,
});

describe("Imported style preservation and explicit approximations", () => {
  it("preserves CSS RGBA colors and literal transparency as canonical native color values", async () => {
    const stroke = canvasStroke();
    Object.assign(stroke.style, { color: "rgba(10, 20, 30, 0.5)" });
    const shapes = [
      {
        kind: "shape",
        id: "ellipse",
        shapeType: "ellipse",
        cx: 10,
        cy: 20,
        rx: 5,
        ry: 4,
        style: { ...shapeStyle, strokeColor: "white", fill: "transparent" },
      },
    ];
    const imported = await convertObsidianInk(
      inkSvg(canvasSnapshot({ strokes: [stroke], shapes })),
      options(),
    );
    expect(imported.snapshot.elements[0]).toMatchObject({
      style: { color: { value: "#0A141E80" } },
    });
    expect(imported.snapshot.elements[1]).toMatchObject({
      style: { outlineColor: { value: "#FFFFFFFF" }, fillColor: { value: "#00000000" } },
    });
  });

  it("retains native one- and twelve-unit outline widths, dots and an explicitly unruled page", async () => {
    const shape = {
      kind: "shape",
      id: "rect",
      shapeType: "rect",
      x: 0,
      y: 0,
      w: 10,
      h: 20,
      cornerRadius: 2,
      style: { ...shapeStyle, strokeWidth: 12, dash: "dotted" },
    };
    const imported = await convertObsidianInk(
      inkSvg(
        canvasSnapshot({
          shapes: [shape],
          gridEnabled: true,
          gridStyle: "dots",
          gridSize: 25,
          writingBackgroundStyle: "none",
        }),
      ),
      options(),
    );
    expect(imported.snapshot.page.background).toEqual({ type: "dots", spacing: 25 });
    expect(imported.snapshot.elements[1]).toMatchObject({
      style: { outlineWidth: 12, outlineStyle: "dotted" },
    });
    expect(imported.warnings).toContain(
      "Rounded rectangles were converted to Inkbook rectangles with square corners.",
    );
    const none = await convertObsidianInk(
      inkSvg(canvasSnapshot({ strokes: [], writingBackgroundStyle: "none" })),
      options(),
    );
    expect(none.snapshot.page.background).toEqual({ type: "none" });
    Object.assign(shape.style, { strokeWidth: 1 });
    const thin = await convertObsidianInk(inkSvg(canvasSnapshot({ shapes: [shape] })), options());
    expect(thin.snapshot.elements[1]).toMatchObject({ style: { outlineWidth: 1 } });
  });
});

describe("Source metadata and legacy style approximations", () => {
  it("handles official XML headers, comments and escaped non-ASCII transcripts", async () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?><!-- Ink -->${inkSvg(canvasSnapshot(), "ink-canvas", "<transcript>&#x1F58A; Übergröße</transcript>")}`;
    expect((await convertObsidianInk(source, options())).transcript).toBe("🖊 Übergröße");
  });

  it("converts bent and patterned legacy shapes with explicit native-geometry warnings", async () => {
    const arrow = tldrawShape("shape:arrow", "arrow", {
      start: { type: "point", x: 0, y: 0 },
      end: { type: "point", x: 100, y: 0 },
      bend: 20,
      dash: "draw",
    });
    const box = {
      ...tldrawShape("shape:box", "geo", { geo: "rectangle", w: 20, h: 10, fill: "pattern" }),
      index: "a2",
    };
    const imported = await convertObsidianInk(
      inkSvg(tldrawSnapshot([arrow, box]), "tldraw"),
      options(),
    );
    expect(imported.snapshot.elements[0]).toMatchObject({
      kind: "arrow",
      bend: { x: 174.3, y: 204.3 },
      style: { outlineStyle: "solid" },
    });
    expect(imported.warnings).toEqual(
      expect.arrayContaining([
        "Curved arrows use Inkbook's native bend geometry.",
        "Pattern fills were converted to native solid fills.",
      ]),
    );
  });
});
