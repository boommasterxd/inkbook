import type {
  BoxShapeElementV1,
  CoordinateSystemElementV1,
  InkElementV1,
  LinearElementV1,
  PointV1,
  StrokeElementV1,
  TableElementV1,
} from "../../domain/schema/public";

export function interpolateElement(
  from: InkElementV1,
  to: InkElementV1,
  progress: number,
): InkElementV1 {
  if (progress >= 1 || from.kind !== to.kind) return to;
  switch (to.kind) {
    case "stroke":
      return from.kind === "stroke" ? interpolateStroke(from, to, progress) : to;
    case "line":
      return from.kind === "line" ? interpolateLinear(from, to, progress) : to;
    case "arrow":
      return from.kind === "arrow" ? interpolateLinear(from, to, progress) : to;
    case "straight-highlighter":
      return from.kind === "straight-highlighter" ? interpolateLinear(from, to, progress) : to;
    case "coordinate-system":
      return from.kind === "coordinate-system" ? interpolateAxes(from, to, progress) : to;
    case "table":
      return from.kind === "table" ? interpolateTable(from, to, progress) : to;
    default:
      return isBox(from) ? interpolateBox(from, to, progress) : to;
  }
}

export function standardMotionProgress(progress: number): number {
  const target = Math.max(0, Math.min(1, progress));
  let parameter = target;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const derivative = cubicDerivative(parameter, 0.2, 0);
    if (Math.abs(derivative) < 0.000_001) break;
    parameter = Math.max(
      0,
      Math.min(1, parameter - (cubic(parameter, 0.2, 0) - target) / derivative),
    );
  }
  return cubic(parameter, 0, 1);
}

function interpolateStroke(
  from: StrokeElementV1,
  to: StrokeElementV1,
  progress: number,
): StrokeElementV1 {
  if (from.points.length !== to.points.length) return to;
  return {
    ...base(from, to, progress),
    ...(from.offset === undefined && to.offset === undefined
      ? {}
      : { offset: point(from.offset ?? { x: 0, y: 0 }, to.offset ?? { x: 0, y: 0 }, progress) }),
    points:
      from.points === to.points
        ? to.points
        : to.points.map((value, index) => number(from.points[index] ?? value, value, progress)),
  };
}

function interpolateLinear<T extends LinearElementV1>(from: T, to: T, progress: number): T {
  const fromBend = from.bend ?? midpoint(from.start, from.end);
  const toBend = to.bend ?? midpoint(to.start, to.end);
  return {
    ...base(from, to, progress),
    bend: from.bend === null && to.bend === null ? null : point(fromBend, toBend, progress),
    end: point(from.end, to.end, progress),
    start: point(from.start, to.start, progress),
  };
}

function interpolateBox(
  from: BoxShapeElementV1,
  to: BoxShapeElementV1,
  progress: number,
): BoxShapeElementV1 {
  return {
    ...base(from, to, progress),
    height: number(from.height, to.height, progress),
    width: number(from.width, to.width, progress),
    x: number(from.x, to.x, progress),
    y: number(from.y, to.y, progress),
  };
}

function interpolateAxes(
  from: CoordinateSystemElementV1,
  to: CoordinateSystemElementV1,
  progress: number,
): CoordinateSystemElementV1 {
  if (from.dimension !== to.dimension) return to;
  const shared = {
    ...base(from, to, progress),
    origin: point(from.origin, to.origin, progress),
  };
  if (from.dimension === "2d" && to.dimension === "2d") {
    return {
      ...shared,
      axes: [point(from.axes[0], to.axes[0], progress), point(from.axes[1], to.axes[1], progress)],
      dimension: "2d",
    };
  }
  if (from.dimension === "3d" && to.dimension === "3d") {
    return {
      ...shared,
      axes: [
        point(from.axes[0], to.axes[0], progress),
        point(from.axes[1], to.axes[1], progress),
        point(from.axes[2], to.axes[2], progress),
      ],
      dimension: "3d",
    };
  }
  return to;
}

function interpolateTable(
  from: TableElementV1,
  to: TableElementV1,
  progress: number,
): TableElementV1 {
  return {
    ...base(from, to, progress),
    columnWidth: number(from.columnWidth, to.columnWidth, progress),
    ...interpolatedColumnOffsets(from, to, progress),
    headerHeight: number(from.headerHeight, to.headerHeight, progress),
    height: number(from.height, to.height, progress),
    x: number(from.x, to.x, progress),
    y: number(from.y, to.y, progress),
  };
}

function interpolatedColumnOffsets(
  from: TableElementV1,
  to: TableElementV1,
  progress: number,
): Pick<TableElementV1, "columnOffsets"> {
  if (from.columnOffsets === undefined && to.columnOffsets === undefined) return {};
  if (
    from.columnOffsets === undefined ||
    to.columnOffsets === undefined ||
    from.columnOffsets.length !== to.columnOffsets.length
  ) {
    return to.columnOffsets === undefined ? {} : { columnOffsets: to.columnOffsets };
  }
  return {
    columnOffsets: to.columnOffsets.map((value, index) =>
      number(from.columnOffsets?.[index] ?? value, value, progress),
    ),
  };
}

function base<T extends InkElementV1>(from: T, to: T, progress: number): T {
  return {
    ...to,
    pivot: point(from.pivot, to.pivot, progress),
    rotation: number(from.rotation, to.rotation, progress),
  };
}

function isBox(element: InkElementV1): element is BoxShapeElementV1 {
  return (
    element.kind === "rectangle" ||
    element.kind === "ellipse" ||
    element.kind === "triangle" ||
    element.kind === "octagon" ||
    element.kind === "parallelogram" ||
    element.kind === "diamond"
  );
}

function midpoint(left: PointV1, right: PointV1): PointV1 {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function point(from: PointV1, to: PointV1, progress: number): PointV1 {
  return { x: number(from.x, to.x, progress), y: number(from.y, to.y, progress) };
}

function number(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function cubic(value: number, first: number, second: number): number {
  const inverse = 1 - value;
  return 3 * inverse * inverse * value * first + 3 * inverse * value * value * second + value ** 3;
}

function cubicDerivative(value: number, first: number, second: number): number {
  const inverse = 1 - value;
  return (
    3 * inverse * inverse * first +
    6 * inverse * value * (second - first) +
    3 * value * value * (1 - second)
  );
}
