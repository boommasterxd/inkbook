import type { InkSnapshotV1, SnapshotValidationDerivations } from "../../domain/schema/public";
import type { DocumentHashPort } from "./sha256";

export type ChunkedInputCheckpoint = () => Promise<void>;

export interface ChunkedInkbookInputOptions {
  readonly staticValidation?: "canonical" | "safe";
  readonly checkpoint?: ChunkedInputCheckpoint;
  readonly hasher?: DocumentHashPort;
  readonly inputSliceBytes?: number;
  readonly onValidatedSnapshot?: (
    snapshot: InkSnapshotV1,
    derivations: SnapshotValidationDerivations,
  ) => Promise<void> | void;
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
