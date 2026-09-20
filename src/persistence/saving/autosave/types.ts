import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../../domain/schema/public";
import type { ExportDelta } from "../../worker/coalesced-export";
import type { DocumentRuntimePort } from "../../worker/runtime/public";
import type { ExistingFilePort, NewFilePort } from "../save-ports";
import type { VaultBase } from "../../worker/protocol";
import type { ActiveSaveProof, ExportSuccess } from "../../worker/protocol";

export type AutosaveStatus =
  | "clean"
  | "conflict"
  | "debouncing"
  | "executor-failed"
  | "retryable-error"
  | "saving"
  | "verification-required"
  | "waiting-for-gesture";

export type AutosaveDelta = ExportDelta<InkElementV1, PageV1>;

export interface AutosaveClock {
  clearTimeout(handle: unknown): void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
}

export interface AutosaveSessionBaseOptions {
  readonly waitForBackground?: () => Promise<void>;
  readonly beforeExistingWrite?: (expectedContent: string) => Promise<void>;
  readonly clock: AutosaveClock;
  readonly confirmed: (persistence: ConfirmedPersistence) => void;
  readonly createFallback?: (workerEpoch: number) => DocumentRuntimePort;
  readonly currentRevision: () => number;
  readonly executor: DocumentRuntimePort;
  readonly initialSnapshot: InkSnapshotV1;
  readonly isGestureActive: () => boolean;
  readonly outputHash: string;
  readonly requiresCanonicalRewrite?: boolean;
  readonly workerEpoch: number;
}

export interface AutosaveDocumentSource {
  currentRevision(): number;
  isGestureActive(): boolean;
  orderByBand(): Readonly<Partial<Record<"content" | "highlight", readonly string[]>>>;
  snapshot(): InkSnapshotV1;
}

export interface ConfirmedPersistence {
  readonly outputHash: string;
  readonly path: string;
  readonly revision: number;
}

export interface AutosaveObserver {
  confirmed?(persistence: ConfirmedPersistence): void;
  statusChanged(status: AutosaveStatus): void;
}

export interface AutosaveCoordinatorOptions {
  readonly waitForBackground?: () => Promise<void>;
  readonly beforeExistingWrite?: (expectedContent: string) => Promise<void>;
  readonly clock: AutosaveClock;
  readonly confirmedBase: VaultBase;
  readonly confirmedContent?: string | null;
  readonly createFallback?: (workerEpoch: number) => DocumentRuntimePort;
  readonly documentSource: AutosaveDocumentSource;
  readonly executor: DocumentRuntimePort;
  readonly initialSnapshot: InkSnapshotV1;
  readonly observer?: AutosaveObserver;
  readonly path: string;
  readonly requiresCanonicalRewrite?: boolean;
  readonly sessionId: string;
  readonly vault: ExistingFilePort & Partial<NewFilePort>;
  readonly workerEpoch?: number;
}

export type FlushReason = "detach" | "lock" | "retry";
export type FlushOutcome =
  "clean" | "conflict" | "executor-failed" | "retryable-error" | "verification-required";
export type ExternalChangeOutcome = "conflict" | "reload-required" | "unchanged";

export interface ActiveAutosave {
  readonly previousBase: VaultBase;
  readonly previousContent: string | null;
  readonly proof: ActiveSaveProof;
  result: ExportSuccess | null;
}

export interface FlushWaiter {
  readonly resolve: (outcome: FlushOutcome) => void;
}
