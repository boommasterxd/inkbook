export const canvasStyle = {
  size: 4,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0,
  simulatePressure: false,
  color: "currentColor",
};

export const shapeStyle = { strokeColor: "#123456", fill: "none", strokeWidth: 4, dash: "solid" };

export function canvasStroke(id = "stroke-a") {
  return {
    id,
    points: [
      [0, 0, 0.25],
      [20, 30, 0.75],
    ],
    offset: { x: 10, y: 20 },
    style: { ...canvasStyle },
  };
}

export function canvasSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    strokes: [canvasStroke()],
    gridEnabled: false,
    writingLineHeight: 100,
    ...overrides,
  };
}

export function inkSvg(snapshot: unknown, engine = "ink-canvas", extra = "") {
  const json = JSON.stringify(snapshot)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-24.3 -24.3 2048.6 400"><metadata><ink file-type="inkWriting"/>${extra}<${engine} version="1">${json}</${engine}></metadata></svg>`;
}

export function tldrawShape(id: string, type = "draw", props: Record<string, unknown> = {}) {
  return {
    id,
    typeName: "shape",
    type,
    x: 100,
    y: 200,
    rotation: 0,
    opacity: 1,
    parentId: "page:main",
    index: "a1",
    props: {
      color: "black",
      size: "s",
      fill: "none",
      dash: "solid",
      scale: 1,
      segments: [
        {
          type: "free",
          points: [
            { x: 0, y: 0, z: 0.2 },
            { x: 10, y: 20, z: 0.8 },
          ],
        },
      ],
      isPen: true,
      isComplete: true,
      ...props,
    },
  };
}

export function tldrawSnapshot(shapes = [tldrawShape("shape:draw")]) {
  return {
    document: {
      store: Object.fromEntries<unknown>([
        [
          "document:document",
          { id: "document:document", typeName: "document", meta: { writingLineHeight: 100 } },
        ],
        ["page:main", { id: "page:main", typeName: "page", index: "a1" }],
        ...shapes.map((shape): [string, unknown] => [shape.id, shape]),
      ]),
    },
    session: { isGridMode: false },
  };
}
