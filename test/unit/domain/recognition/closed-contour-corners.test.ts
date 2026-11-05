import { describe, expect, it } from "vitest";
import { closedContourCorners } from "../../../../src/domain/recognition/closed-contour-corners";
import { CLOSED_VERTICES } from "./recognition-fixtures";

describe("closed contour corner admission", () => {
  it("retains eight actual corners when drawing starts and ends inside a side", () => {
    const vertices = CLOSED_VERTICES.octagon.map(([x, y]) => ({ x: x!, y: y! }));
    const start = { x: (vertices[0]!.x + vertices[1]!.x) / 2, y: vertices[0]!.y };
    const contour = [start, ...vertices.slice(1), vertices[0]!, start];
    const corners = closedContourCorners(contour, 2);
    expect(corners).toHaveLength(8);
    expect(corners).not.toContainEqual(start);
  });

  it("keeps a ninth actual corner outside the supported corner capacity", () => {
    const vertices = Array.from({ length: 9 }, (_, index) => ({
      x: Math.cos((index * 2 * Math.PI) / 9) * 100,
      y: Math.sin((index * 2 * Math.PI) / 9) * 100,
    }));
    expect(closedContourCorners([...vertices, vertices[0]!], 2)).toEqual([]);
  });
});
