import type { LineElementV1, BoxShapeElementV1 } from "../../../../src/domain/schema/public";

export const IDS = {
  highlight: "00000000-0000-4000-8000-000000000001",
  line: "00000000-0000-4000-8000-000000000002",
  other: "00000000-0000-4000-8000-000000000003",
  target: "00000000-0000-4000-8000-000000000004",
} as const;

const OUTLINE_STYLE = {
  outlineColor: { type: "rgba", value: "#112233FF" },
  outlineOpacity: 1,
  outlineStyle: "solid",
  outlineWidth: 4,
} as const;

export function rectangle(id: string = IDS.target, x = 100, y = 100): BoxShapeElementV1 {
  return {
    createdAt: 1,
    height: 100,
    id,
    kind: "rectangle",
    pivot: { x: x + 100, y: y + 50 },
    rotation: 0,
    style: { ...OUTLINE_STYLE, fillColor: null, fillOpacity: 0 },
    width: 200,
    x,
    y,
  };
}

export function connectedLine(target: BoxShapeElementV1 = rectangle()): LineElementV1 {
  return {
    bend: null,
    createdAt: 2,
    end: { x: target.x + target.width + 100, y: target.y },
    endConnection: null,
    endNode: "none",
    id: IDS.line,
    kind: "line",
    pivot: { x: target.x + target.width / 2 + 50, y: target.y },
    rotation: 0,
    start: { x: target.x, y: target.y },
    startConnection: {
      anchor: { kind: "box", position: "top-left" },
      targetId: target.id,
    },
    startNode: "none",
    style: OUTLINE_STYLE,
  };
}
