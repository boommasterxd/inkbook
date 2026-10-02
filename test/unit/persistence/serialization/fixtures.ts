import type {
  BoxShapeElementV1,
  InkElementV1,
  InkSnapshotV1,
  OutlineStyleV1,
  ShapeStyleV1,
  StrokeStyleV1,
} from "../../../../src/domain/schema/public";
import { rewriteDocumentMetadata } from "../../../fixtures/persistence/metadata-rewrite";

const strokeStyle: StrokeStyleV1 = {
  color: { type: "theme-text" },
  width: 4,
  opacity: 0.75,
  pressureEnabled: false,
  smoothing: 0.5,
};

const outlineStyle: OutlineStyleV1 = {
  outlineColor: { type: "theme-text" },
  outlineWidth: 4,
  outlineOpacity: 0.8,
  outlineStyle: "solid",
};

const shapeStyle: ShapeStyleV1 = {
  ...outlineStyle,
  fillColor: { type: "rgba", value: "#33669980" },
  fillOpacity: 0.5,
};

export function createSnapshot(elements: InkElementV1[] = []): InkSnapshotV1 {
  return {
    format: "inkbook",
    version: 1,
    revision: 7,
    page: {
      innerWidth: 2000,
      margin: 24.3,
      background: { type: "lines", spacing: 100 },
      activeBufferLines: 3,
      lockedBufferLines: 1,
    },
    elements,
  };
}

export function createDottedRectangleSnapshot(y: number): InkSnapshotV1 {
  const snapshot = createSnapshot([
    {
      kind: "rectangle",
      id: uuid(99),
      createdAt: 99,
      rotation: 0,
      pivot: { x: 150, y: y + 50 },
      x: 100,
      y,
      width: 100,
      height: 100,
      style: {
        outlineColor: { type: "theme-text" },
        outlineWidth: 4,
        outlineOpacity: 1,
        outlineStyle: "solid",
        fillColor: null,
        fillOpacity: 0,
      },
    },
  ]);
  snapshot.page.background = { type: "dots", spacing: 25 };
  return snapshot;
}

const ALL_ELEMENTS: readonly InkElementV1[] = [
  {
    kind: "straight-highlighter",
    id: uuid(1),
    createdAt: 1,
    rotation: 0,
    pivot: { x: 200, y: 150 },
    start: { x: 100, y: 150 },
    end: { x: 300, y: 150 },
    bend: null,
    startNode: "none",
    endNode: "none",
    style: { ...strokeStyle, color: { type: "rgba", value: "#FFFF0080" }, width: 14 },
  },
  {
    kind: "stroke",
    id: uuid(2),
    createdAt: 2,
    rotation: 0,
    pivot: { x: 150, y: 260 },
    tool: "pen",
    points: [100, 250, 0.5, 150, 270, 0.75, 200, 250, 1],
    style: { ...strokeStyle, pressureEnabled: true },
  },
  {
    kind: "rectangle",
    id: uuid(3),
    createdAt: 3,
    rotation: 0,
    pivot: { x: 450, y: 250 },
    x: 400,
    y: 200,
    width: 100,
    height: 100,
    style: shapeStyle,
  },
  {
    kind: "ellipse",
    id: uuid(4),
    createdAt: 4,
    rotation: 15,
    pivot: { x: 650, y: 250 },
    x: 600,
    y: 200,
    width: 100,
    height: 100,
    style: { ...shapeStyle, fillColor: { type: "theme-text" } },
  },
  polygon("triangle", 5, 800),
  polygon("diamond", 6, 1000),
  polygon("parallelogram", 7, 1200),
  polygon("octagon", 8, 1400),
  {
    kind: "line",
    id: uuid(9),
    createdAt: 9,
    rotation: 0,
    pivot: { x: 450, y: 400 },
    start: { x: 400, y: 400 },
    end: { x: 500, y: 400 },
    bend: { x: 450, y: 350 },
    startNode: "none",
    endNode: "none",
    style: { ...outlineStyle, outlineStyle: "dashed" },
    startConnection: null,
    endConnection: null,
  },
  {
    kind: "arrow",
    id: uuid(10),
    createdAt: 10,
    rotation: 0,
    pivot: { x: 650, y: 400 },
    start: { x: 600, y: 400 },
    end: { x: 700, y: 400 },
    bend: null,
    startNode: "circle",
    endNode: "triangle",
    style: {
      ...outlineStyle,
      outlineColor: { type: "rgba", value: "#AA1122FF" },
      outlineStyle: "dotted",
    },
    startConnection: null,
    endConnection: null,
  },
  {
    kind: "coordinate-system",
    id: uuid(11),
    createdAt: 11,
    rotation: 0,
    pivot: { x: 900, y: 450 },
    origin: { x: 900, y: 450 },
    dimension: "3d",
    axes: [
      { x: 1000, y: 450 },
      { x: 900, y: 350 },
      { x: 850, y: 500 },
    ],
    style: outlineStyle,
  },
  {
    kind: "table",
    id: uuid(12),
    createdAt: 12,
    rotation: 0,
    pivot: { x: 1300, y: 450 },
    x: 1120,
    y: 400,
    columnWidth: 120,
    height: 100,
    columns: 3,
    headerHeight: 30,
    style: outlineStyle,
  },
];

export function createAllElementSnapshot(): InkSnapshotV1 {
  return createSnapshot(ALL_ELEMENTS.map((element) => structuredClone(element)));
}

export function appendMetadataProperty(svg: string, propertyJson: string): string {
  return rewriteDocumentMetadata(
    svg,
    (metadata) => {
      const marker = '"elements":[]}';
      if (!metadata.includes(marker)) throw new Error("Expected empty serialized elements.");
      return metadata.replace(marker, `"elements":[],${propertyJson}}`);
    },
    true,
  );
}

export function wideMetadataArrayProperty(entries: number): string {
  const values = entries === 0 ? "" : `${"0,".repeat(entries - 1)}0`;
  return `"wide":[${values}]`;
}

export function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function polygon(
  kind: "diamond" | "octagon" | "parallelogram" | "triangle",
  id: number,
  x: number,
): BoxShapeElementV1 {
  return {
    kind,
    id: uuid(id),
    createdAt: id,
    rotation: 0,
    pivot: { x: x + 50, y: 250 },
    x,
    y: 200,
    width: 100,
    height: 100,
    style: shapeStyle,
  };
}
