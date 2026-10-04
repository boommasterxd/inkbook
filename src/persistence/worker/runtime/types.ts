import type {
  ElementValidationDerivation,
  InkElementV1,
  InkSnapshotV1,
  PageV1,
} from "../../../domain/schema/public";
import type {
  ClipboardCandidates,
  ClipboardResult,
  ClipboardWritePayload,
  DecodedClipboard,
  PasteInvocation,
  PastePlan,
  PasteRepeatState,
} from "../../clipboard/types";
import type {
  ExportIdentity,
  ExportRequest,
  ExportResult,
  PurposeOperationIdentity,
  VerifiedPersistedOutput,
} from "../protocol";
import type { SafeStaticProof } from "../../serialization/safe-static-proof";

export type DocumentExportRequest = ExportRequest<InkElementV1, PageV1, InkSnapshotV1>;

interface ModelSyncIdentity {
  readonly identity: PurposeOperationIdentity;
  readonly modelRevision: number;
}

export interface FullModelSyncRuntimeRequest extends ModelSyncIdentity {
  readonly baseModelRevision: null;
  readonly snapshot: InkSnapshotV1;
  readonly type: "model-sync-full";
}

export interface IncrementalModelSyncRuntimeRequest extends ModelSyncIdentity {
  readonly baseModelRevision: number;
  readonly changedElementDerivations?: readonly ElementValidationDerivation[];
  readonly changedElements?: readonly InkElementV1[];
  readonly orderChanges?: Readonly<Partial<Record<"content" | "highlight", readonly string[]>>>;
  readonly page?: PageV1;
  readonly removedIds?: readonly string[];
  readonly type: "model-sync-incremental";
}

export type ModelSyncRuntimeRequest =
  FullModelSyncRuntimeRequest | IncrementalModelSyncRuntimeRequest;

export interface UnlockRuntimeRequest {
  readonly identity: PurposeOperationIdentity;
  readonly input: string | Uint8Array;
  readonly type: "unlock";
  readonly safeStaticProof?: SafeStaticProof;
}

/** IDs are in visible-first order; no source-file presentation paths are accepted. */
export interface PrepareScenePathsRuntimeRequest {
  readonly basisRevision: number;
  readonly identity: PurposeOperationIdentity;
  readonly ids: readonly string[];
  readonly type: "prepare-scene-paths";
}

export interface PreparedScenePathsRuntimeSuccess {
  readonly basisRevision: number;
  readonly identity: PurposeOperationIdentity;
  readonly paths: readonly import("../../../domain/geometry/prepared-scene-paths").PreparedScenePathEntry[];
  readonly type: "prepare-scene-paths-success";
}

interface EncodeClipboardRuntimeRequest {
  readonly basisRevision: number;
  readonly identity: PurposeOperationIdentity;
  readonly selectedIds: readonly string[];
  readonly type: "clipboard-encode";
}

interface DecodeClipboardRuntimeRequest {
  readonly basisRevision: number;
  readonly candidates: ClipboardCandidates;
  readonly identity: PurposeOperationIdentity;
  readonly type: "clipboard-decode";
}

interface PlanClipboardPasteRuntimeRequest {
  readonly basisRevision: number;
  readonly candidates: ClipboardCandidates;
  readonly commandTimestamp: number;
  readonly identity: PurposeOperationIdentity;
  readonly invocation: PasteInvocation;
  readonly previousRepeat?: PasteRepeatState;
  readonly type: "clipboard-plan-paste";
}

interface VerifyRuntimeRequest {
  /** Scalar evidence supplied only by the owning save coordinator, never by file markup. */
  readonly confirmedBase?: { readonly outputHash: string; readonly revision: number };
  readonly expectedBytes?: number;
  readonly identity: PurposeOperationIdentity;
  readonly input: string | Uint8Array;
  readonly type: "verify-output";
  readonly versionPolicy?: "current" | "editable";
}

export type DocumentRuntimeRequest =
  | DecodeClipboardRuntimeRequest
  | DocumentExportRequest
  | EncodeClipboardRuntimeRequest
  | ModelSyncRuntimeRequest
  | PlanClipboardPasteRuntimeRequest
  | PrepareScenePathsRuntimeRequest
  | UnlockRuntimeRequest
  | VerifyRuntimeRequest;

interface UnlockRuntimeSuccess {
  readonly identity: PurposeOperationIdentity;
  readonly lockedHeight: number;
  readonly outputHash: string;
  readonly requiresCanonicalRewrite: boolean;
  readonly sourceVersion: number;
  readonly snapshot: Omit<InkSnapshotV1, "elements"> & {
    readonly batchCount: number;
    readonly elementCount: number;
  };
  readonly type: "unlock-success";
}

export interface UnlockRuntimeBatch {
  readonly batchIndex: number;
  readonly derivations: readonly ElementValidationDerivation[];
  readonly elements: readonly InkElementV1[];
  readonly identity: PurposeOperationIdentity;
}

export interface DocumentRuntimeObserver {
  unlockBatch(batch: UnlockRuntimeBatch, signal: AbortSignal): Promise<void> | void;
}

export interface EncodeClipboardRuntimeSuccess {
  readonly identity: PurposeOperationIdentity;
  readonly result: ClipboardResult<ClipboardWritePayload>;
  readonly type: "clipboard-encode-success";
}

export interface DecodeClipboardRuntimeSuccess {
  readonly identity: PurposeOperationIdentity;
  readonly result: ClipboardResult<DecodedClipboard>;
  readonly type: "clipboard-decode-success";
}

export interface PlanClipboardPasteRuntimeSuccess {
  readonly identity: PurposeOperationIdentity;
  readonly result: ClipboardResult<PastePlan>;
  readonly type: "clipboard-plan-paste-success";
}

export interface ModelSyncRuntimeSuccess {
  readonly identity: PurposeOperationIdentity;
  readonly modelRevision: number;
  readonly type: "model-sync-success";
}

interface VerifyRuntimeSuccess {
  readonly identity: PurposeOperationIdentity;
  readonly persisted: VerifiedPersistedOutput;
  readonly type: "verify-output-success";
}

interface RuntimeFailure {
  readonly code: string;
  readonly identity: PurposeOperationIdentity;
  readonly retryable: boolean;
  readonly type: "runtime-failure";
}

export type DocumentRuntimeResult =
  | DecodeClipboardRuntimeSuccess
  | EncodeClipboardRuntimeSuccess
  | ExportResult
  | ModelSyncRuntimeSuccess
  | PlanClipboardPasteRuntimeSuccess
  | PreparedScenePathsRuntimeSuccess
  | RuntimeFailure
  | UnlockRuntimeSuccess
  | VerifyRuntimeSuccess;

export interface DocumentRuntimePort {
  cancelScenePreparation?(identity: PurposeOperationIdentity): void;
  acknowledgeExport?(identity: ExportIdentity, accepted: boolean): void;
  checkpoint?(signal: AbortSignal): Promise<void> | undefined;
  execute(
    request: DocumentRuntimeRequest,
    observer?: DocumentRuntimeObserver,
  ): Promise<DocumentRuntimeResult>;
  requestPrewarm?(): void;
  setLiveInputActive?(active: boolean): void;
  setNavigationActive?(active: boolean): void;
  setSchedulingProfile?(sliceMilliseconds: number, frameIntervalMilliseconds: number): void;
  terminate(): void;
}

export interface DocumentRuntimeServices {
  createId(): string;
  now?(this: void): number;
}

export interface InputAwareSliceScheduler {
  checkpoint(signal: AbortSignal, priority?: "frame"): Promise<void> | undefined;
  getSliceMilliseconds?(): number;
  getSliceWorkProfile?(): RuntimeSliceWorkProfile;
  run<T>(
    operation: (signal: AbortSignal) => T | Promise<T>,
    signal: AbortSignal,
    priority?: "frame",
  ): Promise<T>;
  setLiveInputActive?(active: boolean): void;
  setSchedulingProfile?(sliceMilliseconds: number, frameIntervalMilliseconds: number): void;
}

export interface RuntimeSliceWorkProfile {
  readonly inputByteLimit: number;
  readonly nodeLimit: number;
  readonly outputByteLimit: number;
}

export interface RuntimeSliceContext {
  readonly checkpoint: () => Promise<void> | undefined;
  readonly sliceMilliseconds?: () => number;
  readonly workProfile?: RuntimeSliceWorkProfile;
  readonly signal: AbortSignal;
}
