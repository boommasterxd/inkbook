import { describe, expect, it } from "vitest";

import { calculateElementBounds } from "../../../../../src/domain/geometry/public";
import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  selectionOverlayFill,
  selectionOverlayPath,
} from "../../../../../src/obsidian/embeds/active-editor/selection-overlay-path";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";

function selected(element: InkElementV1) {
  return { bounds: calculateElementBounds(element), element };
}

describe("selection overlay path", () => {
  it("draws a straight line centerline and exactly three handles", () => {
    const path = selectionOverlayPath([selected(connectedLine())], {
      pageToScreen: (point) => point,
      zoom: 1,
    });

    expect(path).toContain("M 100 100 L 400 100");
    expect(path).not.toContain(" Z");
    expect(path?.match(/ a 5 5 0 1 0 10 0/g)).toHaveLength(3);
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
});
