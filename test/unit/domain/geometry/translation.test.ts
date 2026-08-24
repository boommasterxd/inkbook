import { describe, expect, it } from "vitest";

import { translateElementGeometry } from "../../../../src/domain/geometry/public";

describe("element geometry translation", () => {
  it("translates every canonical coordinate of a runtime stroke", () => {
    const source = {
      createdAt: 0,
      id: "00000000-0000-4000-8000-000000000010",
      kind: "stroke",
      pivot: { x: 5, y: 5 },
      points: new Float64Array([0, 0, 0.5, 10, 10, 1]),
      rotation: 0,
      style: {
        color: { type: "theme-text" },
        opacity: 1,
        pressureEnabled: true,
        smoothing: 0.5,
        width: 2,
      },
      tool: "pen",
    } as const;

    const translated = translateElementGeometry(source as never, { x: 2, y: 3 });

    expect(translated.kind).toBe("stroke");
    if (translated.kind !== "stroke") return;
    expect(translated.points).toEqual(new Float64Array([2, 3, 0.5, 12, 13, 1]));
    expect(translated.pivot).toEqual({ x: 7, y: 8 });
  });
});
