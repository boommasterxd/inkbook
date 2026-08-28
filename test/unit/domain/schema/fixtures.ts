import type {
  ArrowElementV1,
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  InkElementV1,
  InkSnapshotV1,
  LineElementV1,
  OutlineStyleV1,
  ShapeStyleV1,
  StraightHighlighterElementV1,
  StrokeElementV1,
  StrokeStyleV1,
  TableElementV1,
} from "../../../../src/domain/schema/public";

export const outlineStyle: OutlineStyleV1 = {
  outlineColor: { type: "theme-text" },
  outlineWidth: 2,
  outlineOpacity: 1,
  outlineStyle: "solid",
};

export const shapeStyle: ShapeStyleV1 = {
  ...outlineStyle,
  fillColor: null,
  fillOpacity: 0,
};

const strokeStyle: StrokeStyleV1 = {
  color: { type: "rgba", value: "#112233FF" },
  width: 4,
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5,
};

export function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

export function stroke(index = 1, tool: "pen" | "highlighter" = "pen"): StrokeElementV1 {
  return {
    kind: "stroke",
    id: uuid(index),
    createdAt: 0,
    rotation: 0,
    pivot: { x: 110, y: 110 },
    tool,
    points: [100, 100, 0.5, 120, 120, 1],
    style: { ...strokeStyle, pressureEnabled: tool === "pen" },
  };
}

export function straightHighlighter(index = 2): StraightHighlighterElementV1 {
  return {
    kind: "straight-highlighter",
    id: uuid(index),
    createdAt: 0,
    rotation: 0,
    pivot: { x: 150, y: 200 },
    start: { x: 100, y: 200 },
    end: { x: 200, y: 200 },
    bend: null,
    startNode: "none",
    endNode: "none",
    style: { ...strokeStyle, pressureEnabled: false },
  };
}

export function rectangle(index = 3): BoxShapeElementV1 {
  return {
    kind: "rectangle",
    id: uuid(index),
    createdAt: 0,
    rotation: 0,
    pivot: { x: 150, y: 150 },
    x: 100,
    y: 100,
    width: 100,
    height: 100,
    style: shapeStyle,
  };
}

export function line(index = 4): LineElementV1 {
  return {
    kind: "line",
    id: uuid(index),
    createdAt: 0,
    rotation: 0,
    pivot: { x: 250, y: 150 },
    start: { x: 200, y: 150 },
    end: { x: 300, y: 150 },
    bend: null,
    startConnection: { targetId: uuid(3), anchor: { kind: "box", position: "middle-right" } },
    endConnection: null,
    startNode: "none",
    endNode: "none",
    style: outlineStyle,
  };
}

export function arrow(index = 5): ArrowElementV1 {
  return {
    ...line(index),
    kind: "arrow",
    startConnection: null,
    startNode: "circle",
    endNode: "arrow",
  };
}

export function coordinateSystem(index = 6): CoordinateSystemElementV1 {
  return {
    kind: "coordinate-system",
    id: uuid(index),
    createdAt: 0,
    rotation: 0,
    pivot: { x: 400, y: 400 },
    origin: { x: 400, y: 400 },
    dimension: "2d",
    axes: [
      { x: 500, y: 400 },
      { x: 400, y: 300 },
    ],
    style: outlineStyle,
  };
}

export function table(index = 7): TableElementV1 {
  return {
    kind: "table",
    id: uuid(index),
    createdAt: 0,
    rotation: 0,
    pivot: { x: 160, y: 340 },
    x: 100,
    y: 300,
    columnWidth: 40,
    height: 80,
    columns: 3,
    headerHeight: 24,
    style: outlineStyle,
  };
}

export function snapshot(elements: InkElementV1[] = []): InkSnapshotV1 {
  return {
    format: "inkbook",
    version: 1,
    revision: 0,
    page: {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "lines", spacing: 50 },
      activeBufferLines: 3,
      lockedBufferLines: 1,
    },
    elements,
  };
}
