import type { ElementValidationDerivation } from "../../domain/schema/public";

export type SessionId = string;
export type ElementId = string;
export type WorkerEpoch = number;
export type DocumentRevision = number;
type ExportGeneration = number;
export type OperationId = number;
type SaveOperationId = number;

export type RenderBand = "content" | "highlight";

export type WorkerPurpose =
  | "background"
  | "clipboard"
  | "migration"
  | "preflight"
  | "read-back"
  | "recovery"
  | "unlock"
  | "verification";

export interface ExecutorIdentity {
  readonly sessionId: SessionId;
  readonly workerEpoch: WorkerEpoch;
}

export interface PurposeOperationIdentity extends ExecutorIdentity {
  readonly operationId: OperationId;
  readonly purpose: WorkerPurpose;
}

export interface ExportIdentity extends ExecutorIdentity {
  readonly exportGeneration: ExportGeneration;
  readonly modelRevision: DocumentRevision;
}

interface FullExportRequest<TSnapshot> extends ExportIdentity {
  readonly baseModelRevision: null;
  readonly snapshot: TSnapshot;
  readonly type: "export-full";
}

interface IncrementalExportRequest<TElement, TPage> extends ExportIdentity {
  readonly baseModelRevision: DocumentRevision;
  readonly changedElementDerivations?: readonly ElementValidationDerivation[];
  readonly changedElements?: readonly TElement[];
  readonly orderChanges?: Readonly<Partial<Record<RenderBand, readonly ElementId[]>>>;
  readonly page?: TPage;
  readonly removedIds?: readonly ElementId[];
  readonly type: "export-incremental";
}

export type ExportRequest<TElement, TPage, TSnapshot> =
  FullExportRequest<TSnapshot> | IncrementalExportRequest<TElement, TPage>;

export interface ExportSuccess extends ExportIdentity {
  readonly output: string | Uint8Array;
  readonly outputHash: string;
  readonly type: "export-success";
}

interface WorkerError {
  readonly code: string;
  readonly retryable: boolean;
}

export interface ExportFailure extends ExportIdentity {
  readonly error: WorkerError;
  readonly type: "export-failure";
}

export type ExportResult = ExportFailure | ExportSuccess;

export type WorkerJobKind = "clipboard" | "export" | "required" | "unlock";

export interface WorkerJob<TPayload> {
  readonly id: string;
  readonly kind: WorkerJobKind;
  readonly payload: TPayload;
}

export type PreparedSuccessor = ExportSuccess;

type SaveWritePhase = "preflight" | "read-back" | "writing";

export interface SaveOperationIdentity {
  readonly saveOperationId: SaveOperationId;
  readonly sessionId: SessionId;
}

export interface ActiveSaveOperation extends SaveOperationIdentity {
  readonly output: string | Uint8Array;
  readonly outputHash: string;
  readonly revision: DocumentRevision;
  readonly workerEpoch: WorkerEpoch;
  readonly writePhase: SaveWritePhase;
}

export interface ActiveSaveProof {
  readonly outputHash: string;
  readonly revision: DocumentRevision;
  readonly saveOperationId: SaveOperationId;
}

export type VaultBase =
  | { readonly type: "missing" }
  | {
      readonly outputHash: string;
      readonly revision: DocumentRevision;
      readonly type: "confirmed";
    };

export interface VerificationRecovery {
  readonly identity: PurposeOperationIdentity;
  readonly previousBase: VaultBase;
  readonly proof: ActiveSaveProof;
}

export type VerifiedPersistedOutput = VaultBase | { readonly type: "unreadable" };

export type VerificationClassification =
  "confirmed" | "conflict" | "retry-verification" | "retry-write" | "stale";
