const STROKES = 10_000;
const STROKE_POINTS = 500_000;
const SHAPES = 500;
const LINEARS = 500;
const ARROW_NODES = ["none", "arrow", "triangle", "diamond", "circle"];
const OUTLINE = {
  outlineColor: { type: "rgba", value: "#113355FF" },
  outlineOpacity: 1,
  outlineStyle: "solid",
  outlineWidth: 4,
};
const UNFILLED = { ...OUTLINE, fillColor: null, fillOpacity: 0 };

function pointCount(index) {
  if (index === 0) return 1;
  if (index === 1) return 500;
  if (index < 10) return 4;
  if (index === 10) return 17;
  if (index === 11) return 50;
  // Successive short and long strokes balance in pairs of 100 points.
  const variation = (Math.floor((index - 12) / 2) * 17) % 48;
  return index % 2 === 0 ? 2 + variation : 98 - variation;
}

function standardStroke(index, id, color) {
  const x = 30 + (index % 50) * 39;
  const y = 30 + Math.floor(index / 50) * 1006;
  const count = pointCount(index);
  const points = new Array(count * 3);
  for (let point = 0; point < count; point += 1) {
    points[point * 3] = x + (point % 32) * 0.25;
    points[point * 3 + 1] = y + (index === 1 ? point * 150 : Math.floor(point / 32) * 0.25);
    points[point * 3 + 2] = (point % 101) / 100;
  }
  return {
    id,
    kind: "stroke",
    tool: "pen",
    createdAt: index,
    rotation: 0,
    pivot: { x: (x + points.at(-3)) / 2, y: (y + points.at(-2)) / 2 },
    points,
    style: { color, opacity: 1, pressureEnabled: true, smoothing: 0.5, width: 8 },
  };
}

function standardShape(index, id) {
  const x = 100 + (index % 10) * 170;
  const y = 500 + Math.floor(index / 10) * 2500;
  const base = { id, createdAt: 20_000, rotation: 0 };
  if (index === 100)
    return {
      ...base,
      kind: "coordinate-system",
      dimension: "2d",
      axes: [
        { x: x + 100, y },
        { x, y: y - 100 },
      ],
      origin: { x, y },
      pivot: { x, y },
      style: OUTLINE,
    };
  if (index === 200)
    return {
      ...base,
      kind: "table",
      columns: 3,
      columnWidth: 50,
      headerHeight: 30,
      height: 100,
      pivot: { x: x + 75, y: y + 50 },
      style: OUTLINE,
      x,
      y,
    };
  const height = index === 1 ? 70_000 : 100;
  return {
    ...base,
    kind: "rectangle",
    width: 120,
    height,
    x,
    y,
    pivot: { x: x + 60, y: y + height / 2 },
    style: UNFILLED,
  };
}

function standardLinear(index, id, target) {
  const bothConnected = index < 256;
  const start = { x: target.x, y: target.y };
  const end = {
    x: target.x + target.width + (bothConnected ? 0 : 80),
    y: target.y + target.height,
  };
  const isLine = index % 2 === 0;
  const arrowIndex = Math.floor(index / 2);
  return {
    id,
    kind: isLine ? "line" : "arrow",
    bend: null,
    createdAt: 30_000 + index,
    end,
    endConnection: bothConnected
      ? { anchor: { kind: "box", position: "bottom-right" }, targetId: target.id }
      : null,
    endNode: isLine ? "none" : ARROW_NODES[(arrowIndex + 2) % ARROW_NODES.length],
    pivot: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    rotation: 0,
    start,
    startConnection: { anchor: { kind: "box", position: "top-left" }, targetId: target.id },
    startNode: isLine ? "none" : ARROW_NODES[arrowIndex % ARROW_NODES.length],
    style: OUTLINE,
  };
}

export function createStandardFixture(id, colors) {
  const strokes = Array.from({ length: STROKES }, (_, index) =>
    standardStroke(index, id(index + 1), colors[index % colors.length]),
  );
  const shapes = Array.from({ length: SHAPES }, (_, index) =>
    standardShape(index, id(STROKES + index + 1)),
  );
  const linears = Array.from({ length: LINEARS }, (_, index) =>
    standardLinear(
      index,
      id(STROKES + SHAPES + index + 1),
      index < 256 ? shapes[0] : shapes[2 + (index % (SHAPES - 2))],
    ),
  );
  if (strokes.reduce((sum, { points }) => sum + points.length / 3, 0) !== STROKE_POINTS)
    throw new Error("The standard fixture has the wrong stroke point count.");
  return {
    elements: [...strokes, ...shapes, ...linears],
    expected: {
      counts: { strokes: STROKES, strokePoints: STROKE_POINTS, shapes: SHAPES, linears: LINEARS },
      minimumLockedHeight: 200_000,
      connectedTargetId: shapes[0].id,
      attachedEndpoints: 512,
      centeredViewportSelection: [strokes[5_000].id, strokes[0].id],
    },
  };
}

function stressStroke(index, id, color, count) {
  const highlighter = index < 7_500;
  const points = new Array(count * 3);
  for (let point = 0; point < count; point += 1) {
    const coordinate = 30 + (point % 2);
    points[point * 3] = coordinate;
    points[point * 3 + 1] = coordinate;
    points[point * 3 + 2] = 0.5;
  }
  return {
    id,
    kind: "stroke",
    tool: highlighter ? "highlighter" : "pen",
    createdAt: index,
    rotation: 0,
    pivot: { x: 30.5, y: 30.5 },
    points,
    style: {
      color,
      opacity: highlighter ? 0.4 : 1,
      pressureEnabled: false,
      smoothing: 0.5,
      width: highlighter ? 14 : 4,
    },
  };
}

export function createStressFixture(id, color, limits) {
  const { strokes, strokePoints } = limits;
  const base = Math.floor(strokePoints / strokes);
  const remainder = strokePoints % strokes;
  const elements = Array.from({ length: strokes }, (_, index) =>
    stressStroke(index, id(200_000 + index), color, base + (index < remainder ? 1 : 0)),
  );
  return { elements, expected: { counts: { strokes, strokePoints } } };
}

export function verifyStressLimits(snapshot, validate, id) {
  const last = snapshot.elements.at(-1);
  const extraPoint = [30, 30, 0.5];
  const tooManyPoints = snapshot.elements.with(-1, {
    ...last,
    points: [...last.points, ...extraPoint],
  });
  const tooManyStrokes = [
    ...snapshot.elements.with(-1, { ...last, points: last.points.slice(0, -3) }),
    { ...last, id: id(300_000), points: extraPoint },
  ];
  const cases = [
    { increase: "strokePoints", code: "stroke-point-limit-exceeded", elements: tooManyPoints },
    { increase: "strokes", code: "stroke-limit-exceeded", elements: tooManyStrokes },
  ];
  return cases.map(({ increase, code, elements }) => {
    const result = validate({ ...snapshot, elements });
    if (result.ok || result.error.code !== code)
      throw new Error(`The stress validation did not reject one extra ${increase} with ${code}.`);
    return { increase, by: 1, code };
  });
}
