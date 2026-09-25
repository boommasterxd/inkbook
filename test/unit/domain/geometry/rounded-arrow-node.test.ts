import { describe, expect, it } from "vitest";

import {
  arrowNodeGeometry,
  buildElementPathParts,
} from "../../../../src/domain/geometry/element-path";
import { roundedArrowNodePath } from "../../../../src/domain/geometry/rounded-arrow-node";
import { arrow } from "../schema/fixtures";

describe("rounded filled arrow nodes", () => {
  it.each(["triangle", "diamond"] as const)("expands %s by a circular outline radius", (kind) => {
    const geometry = arrowNodeGeometry({ x: 10, y: 0 }, { x: 1, y: 0 }, kind, 12);
    if (geometry.kind !== "polygon") throw new Error("Expected polygon node.");
    expect(roundedArrowNodePath(geometry.points, 1).match(/A1 1/g)).toHaveLength(
      geometry.points.length,
    );
  });

  it.each(["triangle", "diamond", "circle"] as const)(
    "preserves short and sharply bent shafts with %s endpoints",
    (node) => {
      for (const end of [
        { x: 100, y: 0 },
        { x: 0.001, y: 0 },
      ]) {
        const target = {
          ...arrow(),
          start: { x: 0, y: 0 },
          end,
          bend: { x: 101, y: 1 },
          startNode: node,
          endNode: node,
        };
        const current = buildElementPathParts(target);
        expect(current).toHaveLength(2);
        expect(current[0]?.d).toContain("Q101 1");
        expect(current[1]?.d).toContain("A");
      }
    },
  );
});
