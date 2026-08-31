import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  selectionOverlayFill,
  selectionOverlayPath,
  selectionOverlayPaths,
} from "../../../../../src/obsidian/embeds/active-editor/selection-overlay-path";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";
import { coordinateSystem, table } from "../../../domain/geometry/fixtures";
import { straightHighlighter } from "../../../domain/schema/fixtures";

function selected(element: InkElementV1) {
  return { bounds: calculateElementBounds(element), element };
}

describe("selection overlay path", () => {
  it("draws a straight line centerline and exactly three handles", () => {
    const paths = selectionOverlayPaths([selected(connectedLine())], {
      pageToScreen: (point) => point,
      zoom: 1,
    });

    expect(paths.outline).toContain("M 100 100 L 400 100");
    expect(paths.outline).not.toContain(" Z");
    expect(paths.outline).not.toContain(" a 5 5");
    expect(paths.handles?.match(/ a 5 5 0 1 0 10 0/g)).toHaveLength(3);
    expect(selectionOverlayFill([selected(connectedLine())])).toBe("none");
  });

  it("draws curved centerlines with a quadratic command", () => {
    const line = { ...connectedLine(), bend: { x: 250, y: 50 } };
    const path = selectionOverlayPath([selected(line)], {
      pageToScreen: (point) => point,
      zoom: 1,
    });

    expect(path).toContain("M 100 100 Q 250 50 400 100");
    expect(path).not.toContain("L 100 100");
    expect(path).not.toContain("Q 250 50 100 100");
  });

  it("draws a curved straight highlighter as an open unfilled overlay", () => {
    const highlighter = { ...straightHighlighter(), bend: { x: 150, y: 160 } };
    const paths = selectionOverlayPaths([selected(highlighter)], {
      pageToScreen: (point) => point,
      zoom: 1,
    });

    expect(paths.outline).toContain("M 100 200 Q 150 160 200 200");
    expect(paths.outline).not.toContain(" Z");
    expect(paths.handles?.match(/ a 5 5 0 1 0 10 0/g)).toHaveLength(3);
    expect(selectionOverlayFill([selected(highlighter)])).toBe("none");
  });

  it("draws a rotated local box without replacing it with an axis-aligned box", () => {
    const shape = { ...rectangle(), rotation: 90 };
    const geometry = [selected(shape)];

    expect(selectionOverlayPath(geometry, { pageToScreen: (point) => point, zoom: 1 })).toContain(
      "M 252 48 L 252 252 L 148 252 L 148 48 Z",
    );
    expect(selectionOverlayFill(geometry)).toBe("accent");
  });

  it("keeps group selection overlays filled even when they include a line", () => {
    const geometry = [selected(rectangle()), selected(connectedLine())];

    expect(selectionOverlayFill(geometry)).toBe("accent");
  });

  it("draws every coordinate axis as an accent editing line", () => {
    const system = coordinateSystem("3d");
    const path = selectionOverlayPath([selected(system)], {
      pageToScreen: (point) => point,
      zoom: 1,
    });

    expect(path).toContain("M 100 100 L 200 100");
    expect(path).toContain("M 100 100 L 100 0");
    expect(path).toContain("M 100 100 L 50 150");
  });

  it("draws the table header and every inner column separator as accent editing lines", () => {
    const source = table();
    const path = selectionOverlayPath([selected(source)], {
      pageToScreen: (point) => point,
      transform: {
        delta: { x: 5, y: 7 },
        kind: "translate",
      },
      zoom: 1,
    });

    expect(path).toContain("M 15 57 L 165 57");
    expect(path).toContain("M 65 27 L 65 127");
    expect(path).toContain("M 115 27 L 115 127");
  });
});
