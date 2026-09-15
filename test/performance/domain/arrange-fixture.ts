import type { BoxShapeElementV1 } from "../../../src/domain/schema/public";

export function arrangeElement(index: number): BoxShapeElementV1 {
  const x = 25 + (index % 100) * 18;
  const y = 25 + Math.floor(index / 100) * 18;
  return {
    createdAt: index,
    height: 8,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    kind: "rectangle",
    pivot: { x: x + 4, y: y + 4 },
    rotation: 0,
    style: {
      fillColor: null,
      fillOpacity: 0,
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    width: 8,
    x,
    y,
  };
}
