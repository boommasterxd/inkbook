import { transformMathPoint, type MathMatrix } from "./math-path-transform";

const ARGUMENTS: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  Z: 0,
};
const NUMBER = /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?$/iu;

/** MathJax glyph commands become absolute M/L/C/Q/Z with all affine transforms baked. */
export function normalizeMathPath(source: string, matrix: MathMatrix): string {
  const tokens = source.match(/[a-z]|[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/giu) ?? [];
  if (
    source.length > 100_000 ||
    source.replace(/[a-z]|[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/giu, "").replace(/[\s,]/gu, "")
  )
    throw new Error("Invalid math path.");
  const state = { x: 0, y: 0, startX: 0, startY: 0, controlX: 0, controlY: 0, previous: "" };
  const result: string[] = [];
  let cursor = 0;
  let command = "";
  while (cursor < tokens.length) {
    if (/^[a-z]$/iu.test(tokens[cursor]!)) command = tokens[cursor++]!;
    const upper = command.toUpperCase();
    const count = ARGUMENTS[upper];
    if (count === undefined || cursor + count > tokens.length)
      throw new Error("Unsupported math path command.");
    const values = tokens.slice(cursor, cursor + count);
    if (values.some((value) => !NUMBER.test(value)))
      throw new Error("Incomplete math path command.");
    cursor += count;
    const output = normalizeCommand(command, values.map(Number), state);
    result.push(
      output.command + output.points.map(([x, y]) => transformMathPoint(matrix, x, y)).join(" "),
    );
    if (upper === "Z") command = "";
    else if (upper === "M") command = command === "M" ? "L" : "l";
  }
  const output = result.join(" ");
  if (output.length > 100_000) throw new Error("Math path exceeds the storage limit.");
  return output;
}

interface PathState {
  x: number;
  y: number;
  startX: number;
  startY: number;
  controlX: number;
  controlY: number;
  previous: string;
}
interface PathOutput {
  command: string;
  points: [number, number][];
}

function normalizeCommand(command: string, values: number[], state: PathState): PathOutput {
  const kind = command.toUpperCase();
  const points = commandPoints(kind, values, command !== kind, state);
  let output = kind;
  if (kind === "Z") {
    state.x = state.startX;
    state.y = state.startY;
  } else {
    if (kind === "H" || kind === "V") output = "L";
    if (kind === "S" || kind === "T") {
      points.unshift(reflectedControl(kind, state));
      output = kind === "S" ? "C" : "Q";
    }
    const end = points[points.length - 1]!;
    if (output === "C" || output === "Q")
      [state.controlX, state.controlY] = points[points.length - 2]!;
    [state.x, state.y] = end;
    if (kind === "M") [state.startX, state.startY] = end;
  }
  state.previous = kind;
  return { command: output, points };
}

function commandPoints(
  kind: string,
  values: number[],
  relative: boolean,
  state: PathState,
): [number, number][] {
  if (kind === "H") return [[values[0]! + (relative ? state.x : 0), state.y]];
  if (kind === "V") return [[state.x, values[0]! + (relative ? state.y : 0)]];
  const points: [number, number][] = [];
  for (let index = 0; index < values.length; index += 2)
    points.push([
      values[index]! + (relative ? state.x : 0),
      values[index + 1]! + (relative ? state.y : 0),
    ]);
  return points;
}

function reflectedControl(kind: string, state: PathState): [number, number] {
  const reflect = kind === "S" ? /[CS]/u.test(state.previous) : /[QT]/u.test(state.previous);
  return reflect
    ? [2 * state.x - state.controlX, 2 * state.y - state.controlY]
    : [state.x, state.y];
}
