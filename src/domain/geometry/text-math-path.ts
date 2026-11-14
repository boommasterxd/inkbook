import { canonicalizeGeometryNumber } from "../schema/canonical";
import { MAX_ABSOLUTE_COORDINATE } from "../schema/constants";

const PARAMETERS: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  C: 6,
  Q: 4,
  H: 1,
  V: 1,
  S: 4,
  T: 2,
  Z: 0,
};
const TOKEN = /[MLCQHVSTZ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Absolute normalized commands contain coordinates only, never arc flags or transforms. */
export function* scaleMathPathDataSteps(path: string, factor: number): Generator<void, string> {
  const chunks: string[] = [];
  yield* inspectMathPathSteps(path, factor, chunks);
  return chunks.join(" ");
}

export function* assertMathPathDataSteps(path: string): Generator<void, void> {
  yield* inspectMathPathSteps(path, 1);
}

function* inspectMathPathSteps(
  path: string,
  factor: number,
  chunks?: string[],
): Generator<void, void> {
  if (!Number.isFinite(factor) || factor <= 0)
    throw new RangeError("Math scale must be positive and finite.");
  const tokens = new RegExp(TOKEN.source, "g");
  let previousEnd = 0;
  let command = "";
  let parameters = 0;
  let count = 0;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(path)) !== null) {
    if (!/^[\s,]*$/.test(path.slice(previousEnd, token.index)))
      throw new RangeError("Unsupported math path token.");
    const text = token[0];
    if (text in PARAMETERS) {
      assertCompleteCommand(command, parameters);
      if (command === "" && text !== "M")
        throw new RangeError("Math paths must start with a move command.");
      command = text;
      parameters = 0;
      chunks?.push(text);
    } else {
      if (command === "" || command === "Z")
        throw new RangeError("Math coordinates require a command.");
      const value = Number(text) * factor;
      if (!Number.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_COORDINATE)
        throw new RangeError("Math coordinates exceed the numeric limit.");
      chunks?.push(String(canonicalizeGeometryNumber(value)));
      parameters += 1;
    }
    previousEnd = tokens.lastIndex;
    if (++count % 256 === 0) yield;
  }
  if (command === "" || !/^[\s,]*$/.test(path.slice(previousEnd)))
    throw new RangeError("Invalid math path data.");
  assertCompleteCommand(command, parameters);
}

function assertCompleteCommand(command: string, parameters: number): void {
  if (command === "") return;
  const required = PARAMETERS[command]!;
  if (required === 0 ? parameters !== 0 : parameters === 0 || parameters % required !== 0)
    throw new RangeError("Math path command has an invalid coordinate count.");
}
