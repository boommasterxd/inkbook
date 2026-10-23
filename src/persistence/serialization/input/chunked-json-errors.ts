export type ChunkedJsonParseErrorCode =
  | "container-limit-exceeded"
  | "depth-limit-exceeded"
  | "duplicate-key"
  | "invalid-json"
  | "node-limit-exceeded"
  | "output-limit-exceeded";

export class ChunkedJsonParseError extends SyntaxError {
  public constructor(
    public readonly code: ChunkedJsonParseErrorCode,
    public readonly offset: number,
    message: string,
  ) {
    super(`${message} at character ${offset}.`);
    this.name = "ChunkedJsonParseError";
  }
}

export class ChunkedJsonCancelledError extends Error {
  public readonly code = "json-parse-cancelled";

  public constructor() {
    super("Chunked JSON parsing was cancelled.");
    this.name = "ChunkedJsonCancelledError";
  }
}
