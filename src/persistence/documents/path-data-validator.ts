import { parseCanonicalSvgDecimal } from "./svg-number";

const MAXIMUM_PATH_BYTES = 8 * 1024 * 1024;
const MAXIMUM_PATH_COMMANDS = 200_000;
const MAXIMUM_COORDINATE = 1_000_000;
const DEFAULT_BYTES_PER_STEP = 16 * 1024;
const DEFAULT_COMMANDS_PER_STEP = 256;
const DEADLINE_CHECK_BYTES = 256;
const COMMAND_ARITY = {
  A: 7,
  a: 7,
  C: 6,
  L: 2,
  M: 2,
  Q: 4,
  q: 4,
  Z: 0,
} as const;

type PathCommand = keyof typeof COMMAND_ARITY;

export interface PathValidationResult {
  readonly commands: number;
  readonly numericTokens: number;
}

export interface PathValidationStepOptions {
  readonly bytesPerStep?: number;
  readonly commandsPerStep?: number;
  readonly deadlineExceeded?: () => boolean;
}

function isSeparator(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function readNumber(
  path: string,
  offset: number,
  allowCompactFraction: boolean,
): { readonly next: number; readonly value: number } | null {
  let cursor = offset;
  if (path[cursor] === "-") cursor += 1;
  const integerStart = cursor;
  const first = path[cursor];
  if (first === "0") {
    cursor += 1;
    if (isDigit(path[cursor])) return null;
  } else if (first !== undefined && first >= "1" && first <= "9") {
    cursor += 1;
    while (isDigit(path[cursor])) {
      cursor += 1;
      if (cursor - integerStart > 7) return null;
    }
  } else if (first !== "." || !allowCompactFraction) {
    return null;
  }
  if (path[cursor] === ".") {
    cursor += 1;
    const fractionStart = cursor;
    while (isDigit(path[cursor]) && cursor - fractionStart < 3) cursor += 1;
    if (cursor === fractionStart || isDigit(path[cursor])) return null;
  }
  const token = path.slice(offset, cursor);
  const value = Number(token);
  return Number.isFinite(value) &&
    Math.abs(value) <= MAXIMUM_COORDINATE &&
    serializeCanonicalDecimal(value) === normalizeFractionToken(token)
    ? { next: cursor, value }
    : null;
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function validateCommandValues(command: PathCommand, values: readonly number[]): boolean {
  if (command !== "A" && command !== "a") return true;
  const [radiusX, radiusY, rotation, largeArc, sweep] = values;
  return (
    radiusX !== undefined &&
    radiusY !== undefined &&
    radiusX > 0 &&
    radiusY > 0 &&
    rotation === 0 &&
    (largeArc === 0 || largeArc === 1) &&
    (sweep === 0 || sweep === 1)
  );
}

/** Yields without accepting partial input whenever a path slice exhausts any configured budget. */
export function* validatePathDataSteps(
  path: string,
  options: PathValidationStepOptions = {},
): Generator<void, PathValidationResult | null> {
  const bytesPerStep = options.bytesPerStep ?? DEFAULT_BYTES_PER_STEP;
  const commandsPerStep = options.commandsPerStep ?? DEFAULT_COMMANDS_PER_STEP;
  if (
    path.length > MAXIMUM_PATH_BYTES ||
    !isPositiveSafeInteger(bytesPerStep) ||
    !isPositiveSafeInteger(commandsPerStep)
  ) {
    return null;
  }
  const validator = new PathValidationMachine(path, bytesPerStep, commandsPerStep, options);
  let step = validator.runSlice();
  while (step === undefined) {
    yield;
    step = validator.runSlice();
  }
  return step;
}

type PathPhase = "command" | "command-separators" | "finish-command" | "value" | "value-separators";
type AdvanceResult = "continue" | "invalid" | "yield";

class PathValidationMachine {
  readonly #bytesPerStep: number;
  readonly #commandsPerStep: number;
  readonly #deadline: (() => boolean) | undefined;
  readonly #path: string;
  readonly #values: number[] = [];
  #activeCommand: PathCommand | undefined;
  #bytes = 0;
  #bytesSinceDeadlineCheck = 0;
  #commands = 0;
  #commandsInStep = 0;
  #commaSeen = false;
  #cursor = 0;
  #numericTokens = 0;
  #phase: PathPhase = "command-separators";
  #subpathOpen = false;
  #currentX = 0;
  #currentY = 0;
  #subpathX = 0;
  #subpathY = 0;

  public constructor(
    path: string,
    bytesPerStep: number,
    commandsPerStep: number,
    options: PathValidationStepOptions,
  ) {
    this.#path = path;
    this.#bytesPerStep = bytesPerStep;
    this.#commandsPerStep = commandsPerStep;
    this.#deadline = options.deadlineExceeded;
  }

  public runSlice(): PathValidationResult | null | undefined {
    this.#resetBudget();
    while (true) {
      const result = this.#advance();
      if (result === "yield") return undefined;
      if (result === "invalid") return null;
      if (this.#phase === "command-separators" && this.#cursor === this.#path.length) {
        return this.#complete();
      }
    }
  }

  #advance(): AdvanceResult {
    switch (this.#phase) {
      case "command-separators":
      case "value-separators":
        return this.#advanceSeparators();
      case "command":
        return this.#advanceCommand();
      case "value":
        return this.#advanceValue();
      case "finish-command":
        return this.#finishCommand();
    }
  }

  #advanceSeparators(): AdvanceResult {
    const character = this.#path[this.#cursor];
    if (character === undefined) {
      return this.#phase === "command-separators" ? "continue" : "invalid";
    }
    if (!isSeparator(character) && character !== ",") {
      this.#phase = this.#phase === "command-separators" ? "command" : "value";
      return "continue";
    }
    if (character === ",") {
      if (this.#commaSeen) return "invalid";
      this.#commaSeen = true;
    }
    this.#cursor += 1;
    return this.#consume(1) ? "yield" : "continue";
  }

  #advanceCommand(): AdvanceResult {
    const command = this.#path[this.#cursor] as PathCommand;
    if (!(command in COMMAND_ARITY) || (this.#commands === 0 && command !== "M")) {
      return "invalid";
    }
    this.#activeCommand = command;
    this.#commands += 1;
    if (this.#commands > MAXIMUM_PATH_COMMANDS) return "invalid";
    this.#commandsInStep += 1;
    this.#commaSeen = false;
    this.#cursor += 1;
    this.#phase = command === "Z" ? "finish-command" : "value-separators";
    return this.#consume(1) ? "yield" : "continue";
  }

  #advanceValue(): AdvanceResult {
    const token = readNumber(
      this.#path,
      this.#cursor,
      this.#activeCommand === "q" || this.#activeCommand === "a",
    );
    if (token === null) return "invalid";
    this.#values.push(token.value);
    this.#numericTokens += 1;
    const bytes = token.next - this.#cursor;
    this.#cursor = token.next;
    this.#commaSeen = false;
    const command = this.#activeCommand!;
    this.#phase =
      this.#values.length === COMMAND_ARITY[command] ? "finish-command" : "value-separators";
    return this.#consume(bytes) ? "yield" : "continue";
  }

  #finishCommand(): AdvanceResult {
    const command = this.#activeCommand!;
    if (!validateCommandValues(command, this.#values)) return "invalid";
    if (command === "M") this.#subpathOpen = true;
    else if (!this.#subpathOpen) return "invalid";
    if (command === "Z") this.#subpathOpen = false;
    if (!this.#updatePosition(command)) return "invalid";
    this.#activeCommand = undefined;
    this.#values.length = 0;
    this.#commaSeen = false;
    this.#phase = "command-separators";
    return "continue";
  }

  #updatePosition(command: PathCommand): boolean {
    if (command === "Z") {
      this.#currentX = this.#subpathX;
      this.#currentY = this.#subpathY;
      return true;
    }
    const values = this.#values;
    const relative = command === "q" || command === "a";
    const firstCoordinate = command === "a" ? 5 : 0;
    if (relative) {
      for (let index = firstCoordinate; index < values.length; index += 2) {
        if (
          Math.abs(this.#currentX + coordinateUnits(values[index]!)) > MAXIMUM_COORDINATE * 1000 ||
          Math.abs(this.#currentY + coordinateUnits(values[index + 1]!)) > MAXIMUM_COORDINATE * 1000
        )
          return false;
      }
    }
    this.#currentX = (relative ? this.#currentX : 0) + coordinateUnits(values[values.length - 2]!);
    this.#currentY = (relative ? this.#currentY : 0) + coordinateUnits(values[values.length - 1]!);
    if (command === "M") {
      this.#subpathX = this.#currentX;
      this.#subpathY = this.#currentY;
    }
    return true;
  }

  #consume(bytes: number): boolean {
    this.#bytes += bytes;
    this.#bytesSinceDeadlineCheck += bytes;
    if (this.#bytes >= this.#bytesPerStep || this.#commandsInStep >= this.#commandsPerStep) {
      return true;
    }
    if (this.#deadline === undefined || this.#bytesSinceDeadlineCheck < DEADLINE_CHECK_BYTES) {
      return false;
    }
    this.#bytesSinceDeadlineCheck = 0;
    return this.#deadline();
  }

  #complete(): PathValidationResult | null {
    return this.#commaSeen || this.#commands === 0
      ? null
      : { commands: this.#commands, numericTokens: this.#numericTokens };
  }

  #resetBudget(): void {
    this.#bytes = 0;
    this.#bytesSinceDeadlineCheck = 0;
    this.#commandsInStep = 0;
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateDashArray(value: string): boolean {
  const tokens = value.trim().split(/[ ,]+/u);
  if (tokens.length === 0 || tokens.length > 8 || tokens.some((token) => token.length === 0)) {
    return false;
  }
  const values = tokens.map((token) => parseCanonicalSvgDecimal(token, 256));
  return values.every((entry) => entry !== null) && values.some((entry) => entry !== 0);
}

function serializeCanonicalDecimal(value: number): string {
  return Object.is(value, -0) ? "0" : value.toString();
}

/** Integer thousandths keep chained relative coordinates exact at the boundary. */
function coordinateUnits(value: number): number {
  return Math.round(value * 1000);
}

function normalizeFractionToken(token: string): string {
  if (token.startsWith(".")) return `0${token}`;
  return token.startsWith("-.") ? `-0${token.slice(1)}` : token;
}
