import type {
  LineElementV1,
  PageV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  InkElementV1,
  StrokeElementV1,
} from "../../../../src/domain/schema/public";

export const IDS = {
  highlight: "00000000-0000-4000-8000-000000000001",
  line: "00000000-0000-4000-8000-000000000002",
  other: "00000000-0000-4000-8000-000000000003",
  target: "00000000-0000-4000-8000-000000000004",
} as const;

export const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "lines", spacing: 50 },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
  writingLineHeight: 50,
};

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

export function highlighter(): StrokeElementV1 {
  return {
    createdAt: 3,
    id: IDS.highlight,
    kind: "stroke",
    pivot: { x: 150, y: 300 },
    points: [100, 300, 0.5, 200, 300, 0.5],
    rotation: 0,
    style: {
      color: { type: "rgba", value: "#FFEE00AA" },
      opacity: 0.5,
      pressureEnabled: false,
      smoothing: 0.5,
      width: 8,
    },
    tool: "highlighter",
  };
}

export function mixedElement(index: number): InkElementV1 {
  const id = `00000000-0000-4000-8000-${(index + 100).toString().padStart(12, "0")}`;
  if (index % 2 === 0) return rectangle(id, 100 + index * 3, 100 + index);
  return {
    ...highlighter(),
    createdAt: index + 1,
    id,
    pivot: { x: 150 + index * 3, y: 300 + index },
    points: [100 + index * 3, 300 + index, 0.5, 200 + index * 3, 300 + index, 0.5],
  };
}

export function coordinateSystem(): CoordinateSystemElementV1 {
  return {
    axes: [
      { x: 500, y: 300 },
      { x: 300, y: 100 },
      { x: 200, y: 400 },
    ],
    createdAt: 1,
    dimension: "3d",
    id: IDS.target,
    kind: "coordinate-system",
    origin: { x: 300, y: 300 },
    pivot: { x: 300, y: 300 },
    rotation: 0,
    style: OUTLINE_STYLE,
  };
}

export function axisConnectedLine(): LineElementV1 {
  return {
    bend: null,
    createdAt: 2,
    end: { x: 700, y: 400 },
    endConnection: null,
    endNode: "none",
    id: IDS.line,
    kind: "line",
    pivot: { x: 450, y: 400 },
    rotation: 0,
    start: { x: 200, y: 400 },
    startConnection: {
      anchor: { kind: "coordinate-axis-end", index: 2 },
      targetId: IDS.target,
    },
    startNode: "none",
    style: OUTLINE_STYLE,
  };
}
