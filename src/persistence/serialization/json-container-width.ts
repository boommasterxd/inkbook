export type JsonContainerScanErrorCode = "container-limit-exceeded" | "depth-limit-exceeded";

export class JsonContainerScanError extends SyntaxError {
  public constructor(
    public readonly code: JsonContainerScanErrorCode,
    public readonly offset: number,
  ) {
    super(`JSON ${code} at character ${offset}.`);
    this.name = "JsonContainerScanError";
  }
}

interface ContainerFrame {
  entries: number;
  hasEntry: boolean;
}

export interface JsonContainerScanOptions {
  readonly batchCharacters: number;
  readonly maximumContainerEntries: number;
  readonly maximumDepth: number;
}

/**
 * Scans structural JSON characters without materializing values. String contents, including
 * escaped quotes and backslashes, never participate in container-width counting.
 */
export function* scanJsonContainerWidths(
  input: string,
  options: JsonContainerScanOptions,
): Generator<void, void> {
  const stack: ContainerFrame[] = [];
  let escaped = false;
  let inString = false;
  let nextCheckpoint = options.batchCharacters;

  for (let position = 0; position < input.length; position += 1) {
    const character = input[position]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else {
      scanStructuralCharacter(character, position, stack, options);
      if (character === '"') inString = true;
    }
    if (position + 1 === nextCheckpoint) {
      nextCheckpoint += options.batchCharacters;
      yield;
    }
  }
}

function scanStructuralCharacter(
  character: string,
  position: number,
  stack: ContainerFrame[],
  options: JsonContainerScanOptions,
): void {
  if (character === '"') {
    markEntry(stack);
    return;
  }
  if (character === "[" || character === "{") {
    markEntry(stack);
    if (stack.length + 1 > options.maximumDepth) {
      throw new JsonContainerScanError("depth-limit-exceeded", position);
    }
    stack.push({ entries: 0, hasEntry: false });
    return;
  }
  if (character === ",") {
    completeEntry(stack, position, options.maximumContainerEntries);
    return;
  }
  if (character === "]" || character === "}") {
    completeEntry(stack, position, options.maximumContainerEntries);
    stack.pop();
    return;
  }
  if (character !== ":" && !isWhitespace(character)) markEntry(stack);
}

function markEntry(stack: ContainerFrame[]): void {
  const frame = stack[stack.length - 1];
  if (frame !== undefined) frame.hasEntry = true;
}

function completeEntry(stack: ContainerFrame[], position: number, maximum: number): void {
  const frame = stack[stack.length - 1];
  if (frame === undefined || !frame.hasEntry) return;
  frame.entries += 1;
  frame.hasEntry = false;
  if (frame.entries > maximum) {
    throw new JsonContainerScanError("container-limit-exceeded", position);
  }
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}
