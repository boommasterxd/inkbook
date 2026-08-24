import type {
  InkSnapshotV1,
  SnapshotValidationDerivations,
  ValidationError,
} from "../../domain/schema/public";

export interface SerializedInkbookDocument<TOutput extends string | Uint8Array = string> {
  readonly hash: string;
  readonly lockedHeight: number;
  readonly metadataBytes: number;
  readonly snapshot: InkSnapshotV1;
  readonly svg: TOutput;
  readonly totalBytes: number;
}

export interface ParsedInkbookDocument {
  readonly derivations: SnapshotValidationDerivations;
  readonly hash: string;
  readonly lockedHeight: number;
  readonly requiresCanonicalRewrite: boolean;
  readonly snapshot: InkSnapshotV1;
  readonly sourceVersion: number;
}

export type DocumentCodecErrorCode =
  | "base-revision-mismatch"
  | "invalid-utf8"
  | "invalid-svg"
  | "invalid-json"
  | "invalid-delta"
  | "invalid-order"
  | "migration-failed"
  | "revision-mismatch"
  | "locked-height-mismatch"
  | "static-path-mismatch"
  | "static-output-limit-exceeded"
  | "snapshot-invalid";

export interface DocumentCodecError {
  readonly code: DocumentCodecErrorCode;
  readonly message: string;
  readonly validationError?: ValidationError;
}

export type DocumentCodecResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: DocumentCodecError; readonly ok: false };
