import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  selectionOverlayFill,
  selectionOverlayPaths,
} from "../../../../../src/obsidian/embeds/active-editor/selection-overlay-path";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";
import { coordinateSystem, table } from "../../../domain/geometry/fixtures";
import { straightHighlighter } from "../../../domain/schema/fixtures";

function selected(element: InkElementV1) {
  return { bounds: calculateElementBounds(element), element };
}

function selectionOverlayPath(...args: Parameters<typeof selectionOverlayPaths>): string {
  return selectionOverlayPaths(...args).outline ?? "";
}

describe("selection overlay path", () => {
  it.each([
    connectedLine(),
    { ...connectedLine(), bend: { x: 250, y: 50 } },
    { ...straightHighlighter(), bend: { x: 150, y: 160 } },
  ])("keeps the $kind trace separate from exactly three handles", (element) => {
    const geometry = [selected(element)];
    const paths = selectionOverlayPaths(geometry, {
      pageToScreen: (point) => point,
      zoom: 1,
    });
    expect(paths.outline).toBeNull();
    expect(paths.handles?.match(/ a 5 5 0 1 0 10 0/g)).toHaveLength(3);
    expect(selectionOverlayFill(geometry)).toBe("none");
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

  it("keeps coordinate axis traces out of the selection frame path", () => {
    const system = coordinateSystem("3d");
    const path = selectionOverlayPath([selected(system)], {
      pageToScreen: (point) => point,
      zoom: 1,
    });

    expect(path).toContain(" Z");
    expect(path.match(/M /gu)).toHaveLength(1);
  });

  it("keeps transformed table separator traces out of the selection frame path", () => {
    const source = table();
    const path = selectionOverlayPath([selected(source)], {
      pageToScreen: (point) => point,
      transform: {
        delta: { x: 5, y: 7 },
        kind: "translate",
      },
      zoom: 1,
    });

    expect(path).toContain(" Z");
    expect(path.match(/M /gu)).toHaveLength(1);
  });
});
