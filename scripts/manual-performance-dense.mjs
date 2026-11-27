const STROKES = 2_500;
const HIT_POINTS = 100;

function markerCenter(index) {
  return { x: 20 + (index % 10) * 30, y: 20 + Math.floor(index / 10) * 30 };
}

function backgroundCenter(index) {
  const backgroundIndex = index - HIT_POINTS;
  return {
    x: 340 + (backgroundIndex % 40),
    y: 20 + Math.floor(backgroundIndex / 40) * 10,
  };
}

function denseStroke(index, id) {
  const center = index < HIT_POINTS ? markerCenter(index) : backgroundCenter(index);
  const highlighter = index % 2 === 0;
  return {
    id,
    createdAt: index,
    kind: "stroke",
    pivot: center,
    points: [center.x - 4, center.y, 0.5, center.x, center.y, 0.5, center.x + 4, center.y, 0.5],
    rotation: 0,
    style: {
      color: { type: "rgba", value: highlighter ? "#FFFF0080" : "#112233FF" },
      opacity: highlighter ? 0.5 : 1,
      pressureEnabled: !highlighter,
      smoothing: 0.5,
      width: highlighter ? 8 : 2,
    },
    tool: highlighter ? "highlighter" : "pen",
  };
}

export function createDenseFixture(id) {
  const elements = Array.from({ length: STROKES }, (_, index) => denseStroke(index, id(index + 1)));
  // Band arrays independently specify ascending rank, followed back to front in the SVG.
  const bands = {
    highlight: Array.from({ length: STROKES / 2 }, (_, rank) => id(2 * rank + 1)),
    content: Array.from({ length: STROKES / 2 }, (_, rank) => id(2 * rank + 2)),
  };
  return {
    elements: [
      ...elements.filter(({ tool }) => tool === "highlighter"),
      ...elements.filter(({ tool }) => tool === "pen"),
    ],
    expectations: {
      bands,
      ids: [...bands.highlight, ...bands.content],
      hits: Array.from({ length: HIT_POINTS }, (_, index) => ({
        expectedId: id(index + 1),
        point: markerCenter(index),
      })),
    },
  };
}
