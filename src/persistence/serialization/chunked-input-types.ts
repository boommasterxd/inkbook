import type { DocumentHashPort } from "./sha256";
import type { ValidatedSnapshotConsumer } from "./validated-snapshot-adoption";

export type ChunkedInputCheckpoint = () => Promise<void> | undefined;

export interface ChunkedInkbookInputOptions {
  readonly staticValidation?: "canonical" | "safe";
  readonly checkpoint?: ChunkedInputCheckpoint;
  readonly hasher?: DocumentHashPort;
  readonly inputSliceBytes?: number;
  readonly onValidatedSnapshot?: ValidatedSnapshotConsumer;
  readonly pathBatchSize?: number;
  readonly signal?: AbortSignal;
}

export class ChunkedInputCancelledError extends Error {
  public readonly code = "input-cancelled";

  public constructor() {
    super("Chunked document input was cancelled.");
    this.name = "ChunkedInputCancelledError";
  }
}
