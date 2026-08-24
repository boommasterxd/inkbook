import { describe, expect, it } from "vitest";

import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";

import { rectangle, snapshot, stroke } from "./fixtures";

describe("snapshot viewport clipping", () => {
  it("accepts shape and freehand geometry beyond fixed viewport edges", () => {
    const outsideShape = rectangle();
    outsideShape.x = -500;
    outsideShape.y = -100;
    outsideShape.pivot = { x: -450, y: -50 };
    const outsideStroke = stroke();
    outsideStroke.points = [-500, -100, 0.5, 2_500, 120, 1];
    outsideStroke.pivot = { x: 1_000, y: 10 };

    expect(validateInkSnapshotV1(snapshot([outsideShape, outsideStroke])).ok).toBe(true);
  });
});
